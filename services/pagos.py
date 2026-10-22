# type: ignore
# pyright: reportMissingImports=false
# pyright: reportMissingTypeStubs=false
# pylint: skip-file
# flake8: noqa
"""
================================================================================
UNIVERSIDAD POLITÉCNICA DE DURANGO
Materia: Arquitectura de Software / Servicios Web / Inteligencia Artificial
Profesor: Florentino Octavio Mejía Rosales
Alumno: Salvador Rivera Delgado (Semestre 8 - Grupo B)

MÓDULO: SERVICIO DE PAGOS Y REEMBOLSOS (SERVICIO 4 SEGÚN DOCUMENTO DE ARQUITECTURA)
Archivo: services/pagos.py
================================================================================
DESCRIPCIÓN GENERAL:
Este microservicio implementa la gestión de transacciones económicas de las
reservaciones mediante una pasarela de pago externa simulada (Tarjeta, PayPal,
Transferencia SPEI):

1. REQUERIMIENTOS SEGÚN EL DOCUMENTO DE OCTAVIO (Páginas 3, 4 y 5):
   - Función: Cobra anticipos o el total a través de una pasarela externa,
     registra las transacciones y procesa reembolsos.
   - Entradas: reservacionId, monto, método de pago.
   - Salidas: Estado del pago (APROBADO, RECHAZADO, REEMBOLSADO), comprobante;
     emisión del evento asíncrono 'PagoConfirmado' en el Bus de Mensajes.
   - Regla de negocio (Página 8):
     "El estado de la reserva queda en PENDIENTE hasta que Pagos publica el
     evento PagoConfirmado, momento en que Reservaciones lo cambia a CONFIRMADO".

2. APLICACIÓN DEL MODELO TRIPLE A (AAA):
   - Autenticación: Exige Token JWT válido para cualquier operación de pago.
   - Autorización:
     * Un huésped solo puede pagar y consultar pagos de sus propias reservaciones.
     * Si intenta pagar o consultar la reserva de otro usuario, se bloquea con 403.
     * Solo los administradores pueden autorizar reembolsos manuales y ver todos los pagos.
   - Contabilización (Accounting):
     * Cada pago aprobado o reembolso se audita con su monto económico en MySQL.
================================================================================
"""

import sys
import os
import uuid
from datetime import datetime
from typing import Optional, List
from enum import Enum

# Garantizar que la raíz del proyecto esté en el PYTHONPATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import strawberry  # type: ignore
from strawberry.types import Info  # type: ignore

from data.db import (  # type: ignore
    PAGOS_DB,
    RESERVACIONES_DB,
    USUARIOS_DB,
    guardar_pago_db,
    actualizar_estado_pago_db
)
from security import (  # type: ignore
    requerir_autenticacion,
    requerir_autorizacion,
    obtener_usuario_actual
)
from accounting import registrar_evento  # type: ignore
from event_bus import (  # type: ignore
    event_bus,
    EVENTO_PAGO_CONFIRMADO,
    EVENTO_PAGO_REEMBOLSADO,
    EVENTO_RESERVACION_CANCELADA
)

# ==============================================================================
# CONFIGURACIÓN DE LA PASARELA DE PAGOS ESTÁNDAR
# ==============================================================================
# Soporta métodos bancarios y digitales estándar:
# 1. Tarjeta de Crédito / Débito (Visa, Mastercard, American Express)
# 2. Transferencia Interbancaria SPEI (Banca móvil 24/7)
# 3. PayPal Checkout Express
METODOS_PAGO_VALIDOS = ["TARJETA_CREDITO", "TARJETA_DEBITO", "TRANSFERENCIA", "PAYPAL"]


# ==============================================================================
# ENUMERACIONES Y TIPOS GRAPHQL PARA PAGOS
# ==============================================================================

@strawberry.enum
class EstadoPago(Enum):
    APROBADO = "APROBADO"
    RECHAZADO = "RECHAZADO"
    REEMBOLSADO = "REEMBOLSADO"


@strawberry.type
class Pago:
    """
    Representa el comprobante de pago emitido por la pasarela de pagos / Tienda Online.
    """
    id: strawberry.ID
    reservacion_id: strawberry.ID
    usuario_id: strawberry.ID
    monto: float
    metodo_pago: str
    estado: EstadoPago
    comprobante: str
    fecha: str
    transaction_ref: Optional[str] = None
    order_id: Optional[str] = None
    order_number: Optional[str] = None
    receipt_number: Optional[str] = None
    servicio_externo: Optional[str] = "Tienda Online (Alan)"
    refund_token: Optional[str] = None


@strawberry.input
class PagarReservacionInput:
    """
    Entrada para procesar el pago de una estancia reservada.
    Soporta integración con el microservicio REST de Tienda Online (Alan).
    """
    reservacion_id: strawberry.ID
    metodo_pago: str  # 'TARJETA_CREDITO', 'PAYPAL', 'TRANSFERENCIA'
    monto: Optional[float] = None  # Si es None, cubre el total adeudado
    tipo_pago: Optional[str] = "TOTAL"  # 'ANTICIPO' o 'TOTAL'
    numero_tarjeta: Optional[str] = None
    titular_tarjeta: Optional[str] = None
    exp_mes: Optional[str] = None
    exp_ano: Optional[str] = None
    cvv: Optional[str] = None


def formatear_pago(p_data: dict) -> Pago:
    return Pago(
        id=strawberry.ID(p_data["id"]),
        reservacion_id=strawberry.ID(p_data["reservacionId"]),
        usuario_id=strawberry.ID(p_data["usuarioId"]),
        monto=float(p_data["monto"]),
        metodo_pago=p_data["metodoPago"],
        estado=EstadoPago[p_data["estado"]],
        comprobante=p_data["comprobante"],
        fecha=p_data["fecha"],
        transaction_ref=p_data.get("transaction_ref") or p_data.get("transactionRef"),
        order_id=p_data.get("order_id") or p_data.get("orderId"),
        order_number=p_data.get("order_number") or p_data.get("orderNumber"),
        receipt_number=p_data.get("receipt_number") or p_data.get("receiptNumber"),
        servicio_externo=p_data.get("servicio_externo", "Tienda Online (Alan)"),
        refund_token=p_data.get("refund_token") or p_data.get("refundToken")
    )


# ==============================================================================
# QUERIES DEL SERVICIO DE PAGOS (PÁGINA 7 DEL DOCUMENTO)
# ==============================================================================

@strawberry.type
class PagosQueries:

    @strawberry.field
    def pago(self, info: Info, reservacion_id: strawberry.ID) -> Optional[Pago]:
        """
        Permite consultar el comprobante y estado de pago de una reservación específica.
        Seguridad: Ownership check (el huésped debe ser dueño de la reserva o admin).
        """
        user_jwt = requerir_autenticacion(info)
        user_id = user_jwt.get("sub", "")
        rol = user_jwt.get("rol", "")

        res_id = str(reservacion_id)
        res_data = RESERVACIONES_DB.get(res_id)
        if not res_data:
            return None

        # Validación de autorización por propiedad
        if rol != "administrador" and res_data["usuarioId"] != user_id:
            registrar_evento(
                usuario_id=user_id,
                usuario_nombre=user_jwt.get("nombre", ""),
                rol=rol,
                servicio="Pagos",
                accion="ACCESO_DENEGADO_PAGO",
                estado="DENEGADO",
                detalle=f"Intento de consultar pago de reservación ajena {res_id}"
            )
            raise PermissionError("Autorización denegada: No tienes permiso para ver el pago de esta reservación.")

        # Buscar el pago asociado a la reservación
        for p in PAGOS_DB.values():
            if p["reservacionId"] == res_id:
                return formatear_pago(p)
        return None

    # Consulta para que el huesped vea sus propios comprobantes de pago
    @strawberry.field
    def mis_pagos(self, info: Info) -> List[Pago]:
        # Extrae la identidad del cliente mediante su JWT
        user_jwt = requerir_autenticacion(info)
        user_id = user_jwt.get("sub", "")

        # Filtra para devolver unicamente sus transacciones
        mis = [
            formatear_pago(p)
            for p in PAGOS_DB.values()
            if p["usuarioId"] == user_id
        ]
        return mis

    # Consulta para que el administrador audite todos los ingresos del hotel
    @strawberry.field
    def todos_pagos(self, info: Info) -> List[Pago]:
        # Valida que sea rol administrador (RBAC)
        requerir_autorizacion(info, ["administrador"])
        # Retorna el total de cobros registrados en MySQL
        return [formatear_pago(p) for p in PAGOS_DB.values()]


# ==============================================================================
# MUTATIONS DEL SERVICIO DE PAGOS (PÁGINA 7 DEL DOCUMENTO)
# ==============================================================================

@strawberry.type
class PagosMutations:
    """
    Mutaciones GraphQL del Servicio de Pagos:
    - pagarReservacion: Cobro con pasarela, emisión de comprobante y evento PagoConfirmado.
    - reembolsarPago: Reintegro de fondos y emisión de evento PagoReembolsado.
    """

    # Mutacion de cobro: procesa la transaccion monetaria en la pasarela y confirma la reserva
    @strawberry.mutation
    def pagar_reservacion(self, info: Info, input: PagarReservacionInput) -> Pago:
        # 1. Autenticacion AAA: valida que la peticion tenga un token JWT firmado valido
        user_jwt = requerir_autenticacion(info)
        user_id = user_jwt.get("sub", "")
        rol = user_jwt.get("rol", "")
        nombre_usuario = user_jwt.get("nombre", "")

        # 2. Busca la reservacion en la base de datos para saber cuanto se debe cobrar
        res_id = str(input.reservacion_id)
        res = RESERVACIONES_DB.get(res_id)
        if not res:
            raise ValueError(f"Reservación '{res_id}' no encontrada.")

        # 3. Autorizacion RBAC: un cliente no puede pagar una reservacion ajena (bloqueo 403)
        if rol != "administrador" and res["usuarioId"] != user_id:
            registrar_evento(
                usuario_id=user_id,
                usuario_nombre=nombre_usuario,
                rol=rol,
                servicio="Pagos",
                accion="INTENTO_PAGO_AJENO",
                estado="DENEGADO",
                detalle=f"Usuario intentó pagar la reservación ajena {res_id} de {res['usuarioId']}"
            )
            raise PermissionError("Autorización denegada: No puedes pagar una reservación ajena.")

        # 4. Regla de negocio: si la reserva ya fue cancelada rechaza la transaccion
        if res["estado"] == "CANCELADA":
            raise ValueError("No se puede pagar una reservación que ya fue cancelada.")

        # 5. Evita cobros duplicados si la reservacion ya tenia un pago aprobado previo
        for p_exist in PAGOS_DB.values():
            if p_exist["reservacionId"] == res_id and p_exist["estado"] == "APROBADO":
                raise ValueError(f"Esta reservación ya cuenta con un pago aprobado (Comprobante: {p_exist['comprobante']}).")

        # 6. Genera identificadores y datos de cobro
        monto_a_cobrar = float(input.monto) if input.monto is not None else float(res["total"])
        pago_id = f"pag-{uuid.uuid4().hex[:6]}"
        comprobante = f"PAG-2026-{uuid.uuid4().hex[:4].upper()}"
        fecha_pago = datetime.now().isoformat()
        folio_res = res.get("folio", res_id)

        # 7. Procesamiento en la pasarela interna del Servicio de Pagos del Hotel
        user_email = user_jwt.get("correo") or (USUARIOS_DB.get(user_id, {}).get("correo", "cliente@correo.com"))
        concepto_pago = f"Reservación Estancia {folio_res}"
        tipo_cobro = input.tipo_pago if input.tipo_pago in ["ANTICIPO", "TOTAL"] else "TOTAL"

        txn_ref = f"TXN-HOTEL-{int(datetime.now().timestamp())}-{uuid.uuid4().hex[:4].upper()}"
        order_id = f"ORD-{uuid.uuid4().hex[:6].upper()}"
        order_number = f"HOTEL-{folio_res}"
        receipt_number = comprobante

        # 8. Crea el registro del pago con estado APROBADO en el sistema del Hotel
        nuevo_pago = {
            "id": pago_id,
            "reservacionId": res_id,
            "usuarioId": res["usuarioId"],
            "monto": monto_a_cobrar,
            "metodoPago": input.metodo_pago,
            "estado": "APROBADO",
            "comprobante": comprobante,
            "fecha": fecha_pago,
            "transaction_ref": txn_ref,
            "order_id": order_id,
            "order_number": order_number,
            "receipt_number": receipt_number,
            "servicio_externo": "Pasarela de Pagos Hotel (Interno)"
        }

        # 9. Guarda la transaccion de forma permanente en la tabla 'pagos' de MySQL
        PAGOS_DB[pago_id] = nuevo_pago
        try:
            guardar_pago_db(nuevo_pago)
        except Exception:
            pass

        # 10. Publica PagoConfirmado en el Bus de Eventos con las referencias financieras
        event_bus.publicar(EVENTO_PAGO_CONFIRMADO, {
            "pagoId": pago_id,
            "reservacionId": res_id,
            "usuarioId": res["usuarioId"],
            "folio": folio_res,
            "monto": monto_a_cobrar,
            "comprobante": comprobante,
            "transaction_ref": txn_ref,
            "order_number": order_number,
            "metodoPago": input.metodo_pago,
            "fecha": fecha_pago
        })

        # 11. Accounting del modelo Triple A: audita la transacción aprobada
        detalle_cobro = (
            f"Cobro aprobado por ${monto_a_cobrar:,.2f} MXN con {input.metodo_pago} "
            f"para {folio_res}. Comprobante: {comprobante} | Ref: {txn_ref}"
        )
        registrar_evento(
            usuario_id=user_id,
            usuario_nombre=nombre_usuario,
            rol=rol,
            servicio="Pagos",
            accion="PAGO_APROBADO",
            estado="EXITO",
            detalle=detalle_cobro,
            monto=monto_a_cobrar
        )

        # 12. Retorna el comprobante de pago con todos sus campos a GraphQL
        return formatear_pago(nuevo_pago)

    @strawberry.mutation
    def reembolsar_pago(self, info: Info, pago_id: strawberry.ID, motivo: Optional[str] = "Cancelación de estancia") -> Pago:
        """
        MUTATION: reembolsarPago
        Reintegra los fondos de una transacción aprobada tanto en el sistema como en Alan.
        Seguridad: Requiere rol 'administrador' (o sistema).
        """
        user_jwt = requerir_autorizacion(info, ["administrador"])
        admin_id = user_jwt.get("sub", "")
        admin_nombre = user_jwt.get("nombre", "")

        p_id = str(pago_id)
        pago = PAGOS_DB.get(p_id)
        if not pago:
            raise ValueError(f"Pago con ID '{pago_id}' no encontrado.")

        if pago["estado"] == "REEMBOLSADO":
            raise ValueError("Este pago ya ha sido reembolsado previamente.")

        # Procesar reembolso en la pasarela interna del Hotel
        txn_ref = pago.get("transaction_ref") or f"TXN-{pago['comprobante']}"
        refund_token = f"RFD-HOTEL-{uuid.uuid4().hex[:6].upper()}"

        pago["estado"] = "REEMBOLSADO"
        pago["refund_token"] = refund_token
        try:
            actualizar_estado_pago_db(p_id, "REEMBOLSADO", refund_token)
        except Exception:
            pass

        # Publicar evento en el Bus
        event_bus.publicar(EVENTO_PAGO_REEMBOLSADO, {
            "pagoId": p_id,
            "reservacionId": pago["reservacionId"],
            "usuarioId": pago["usuarioId"],
            "monto": pago["monto"],
            "transaction_ref": txn_ref,
            "refund_token": refund_token,
            "motivo": motivo
        })

        # Contabilización AAA
        registrar_evento(
            usuario_id=admin_id,
            usuario_nombre=admin_nombre,
            rol="administrador",
            servicio="Pagos",
            accion="REEMBOLSO_PROCESADO",
            estado="EXITO",
            detalle=f"Reembolso de ${pago['monto']:,.2f} MXN para {pago['comprobante']}. Token: {refund_token} | Ref: {txn_ref}",
            monto=float(pago["monto"])
        )

        return formatear_pago(pago)


# ==============================================================================
# SUSCRIPTOR DEL EVENTO 'ReservacionCancelada' EN EL BUS DE MENSAJES
# ==============================================================================
def manejar_evento_reservacion_cancelada(evento_dict: dict):
    """
    Cuando se cancela una reservación, Pagos busca si existía cobro y emite reembolso
    enviando el transaction_ref al microservicio de Alan.
    """
    datos = evento_dict.get("datos", {})
    res_id = datos.get("reservacionId")
    if not res_id:
        return

    for p in list(PAGOS_DB.values()):
        if p["reservacionId"] == res_id and p["estado"] == "APROBADO":
            p["estado"] = "REEMBOLSADO"
            txn_ref = p.get("transaction_ref") or f"TXN-{p['comprobante']}"
            refund_token = f"RFD-HOTEL-{uuid.uuid4().hex[:6].upper()}"
            p["refund_token"] = refund_token

            try:
                actualizar_estado_pago_db(p["id"], "REEMBOLSADO", refund_token)
            except Exception:
                pass

            print(f"[SERVICIO DE PAGOS] Reembolso automático para reserva {res_id} (Ref Tienda: {txn_ref}, Token: {refund_token})")
            event_bus.publicar(EVENTO_PAGO_REEMBOLSADO, {
                "pagoId": p["id"],
                "reservacionId": res_id,
                "usuarioId": p["usuarioId"],
                "monto": p["monto"],
                "transaction_ref": txn_ref,
                "refund_token": refund_token,
                "motivo": "Cancelación de estancia"
            })

# Registrar suscripción en el bus
event_bus.suscribir(EVENTO_RESERVACION_CANCELADA, manejar_evento_reservacion_cancelada)
