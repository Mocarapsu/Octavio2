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

MÓDULO: SERVICIO DE NOTIFICACIONES (SERVICIO 5 SEGÚN DOCUMENTO DE ARQUITECTURA)
Archivo: services/notificaciones.py
================================================================================
DESCRIPCIÓN GENERAL:
Este microservicio reacciona de forma autónoma y asíncrona a los eventos
distribuidos por el Bus de Mensajes (ESB / RabbitMQ / Kafka) para despachar
correos electrónicos y mensajes SMS a huéspedes y administradores:

1. REQUERIMIENTOS SEGÚN EL DOCUMENTO DE OCTAVIO (Páginas 3, 4, 5 y 7):
   - Función: Envía correos o SMS de confirmación, recordatorio y cancelación.
   - Endpoints públicos de mutación: NINGUNA; se activa 100% por eventos del bus.
   - Consultas GraphQL:
     * Solo historial de notificaciones para administradores (y bandeja de entrada personal).
   - Eventos a los que reacciona:
     * 'ReservacionCreada': Notificación de reserva en espera de pago.
     * 'PagoConfirmado': Envío del comprobante oficial y confirmación de estancia.
     * 'ReservacionCancelada': Notificación de estancia anulada.
     * 'PagoReembolsado': Comprobante de reintegro monetario.

2. APLICACIÓN DEL MODELO TRIPLE A (AAA):
   - Autenticación: El acceso a la consulta del historial exige Token JWT válido.
   - Autorización:
     * Solo administradores pueden inspeccionar el historial global del sistema.
     * Los clientes únicamente pueden ver los mensajes despachados a su nombre.
   - Contabilización (Accounting):
     * Cada notificación generada se registra en la bitácora contable de MySQL.
================================================================================
"""

import sys
import os
import uuid
from datetime import datetime
from typing import Optional, List

# Garantizar que la raíz del proyecto esté en el PYTHONPATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import strawberry  # type: ignore
from strawberry.types import Info  # type: ignore

from data.db import (  # type: ignore
    NOTIFICACIONES_DB,
    USUARIOS_DB,
    RESERVACIONES_DB,
    guardar_notificacion_db,
    eliminar_notificacion_db,
    limpiar_notificaciones_db,
    limpiar_todas_notificaciones_db
)
from security import (  # type: ignore
    requerir_autenticacion,
    requerir_autorizacion,
    obtener_usuario_actual
)
from accounting import registrar_evento  # type: ignore
from event_bus import (  # type: ignore
    event_bus,
    EVENTO_RESERVACION_CREADA,
    EVENTO_PAGO_CONFIRMADO,
    EVENTO_RESERVACION_CANCELADA,
    EVENTO_PAGO_REEMBOLSADO
)


# ==============================================================================
# TIPOS GRAPHQL PARA NOTIFICACIONES
# ==============================================================================

@strawberry.type
class Notificacion:
    """
    Representa un correo o SMS despachado por el servicio de notificaciones.
    """
    id: strawberry.ID
    usuario_id: strawberry.ID
    canal: str              # 'EMAIL' o 'SMS'
    destinatario: str       # Correo electrónico o número celular
    asunto: str             # Título o cabecera del mensaje
    mensaje: str            # Contenido del cuerpo de la notificación
    evento_origen: str      # Nombre del evento que disparó el envío (ej: 'PagoConfirmado')
    fecha_envio: str        # Timestamp ISO del envío
    estado: str             # 'ENVIADO'


def formatear_notificacion(n: dict) -> Notificacion:
    return Notificacion(
        id=strawberry.ID(n["id"]),
        usuario_id=strawberry.ID(n["usuarioId"]),
        canal=n.get("canal", "EMAIL"),
        destinatario=n.get("destinatario", ""),
        asunto=n.get("asunto", ""),
        mensaje=n.get("mensaje", ""),
        evento_origen=n.get("eventoOrigen", ""),
        fecha_envio=n.get("fechaEnvio", ""),
        estado=n.get("estado", "ENVIADO")
    )


# ==============================================================================
# QUERIES DEL SERVICIO DE NOTIFICACIONES (PÁGINA 7 DEL DOCUMENTO)
# ==============================================================================

@strawberry.type
class NotificacionesQueries:
    """
    Consultas GraphQL del Servicio de Notificaciones:
    - historialNotificaciones: Acceso a la bitácora de mensajes (Administradores).
    - misNotificaciones: Mensajes recibidos por el usuario en sesión.
    """

    # Endpoint del admin: valida que tenga rol administrador por JWT, registra auditoria en MySQL y regresa todos los mensajes
    @strawberry.field
    def historial_notificaciones(
        self,
        info: Info,
        usuario_id: Optional[strawberry.ID] = None
    ) -> List[Notificacion]:
        # Valida que el JWT sea de rol administrador (modelo RBAC)
        user_jwt = requerir_autorizacion(info, ["administrador"])
        
        lista = NOTIFICACIONES_DB
        if usuario_id:
            lista = [n for n in lista if n["usuarioId"] == str(usuario_id)]

        # Registra la accion en la tabla auditoria de MySQL (Accounting de Triple A)
        registrar_evento(
            usuario_id=user_jwt.get("sub", ""),
            usuario_nombre=user_jwt.get("nombre", ""),
            rol="administrador",
            servicio="Notificaciones",
            accion="CONSULTAR_HISTORIAL_NOTIFICACIONES",
            estado="EXITO",
            detalle=f"Administrador consultó historial ({len(lista)} mensajes)"
        )

        return [formatear_notificacion(n) for n in lista]

    # Endpoint del cliente: valida que este logueado y filtra en MySQL para entregarle solo sus notificaciones
    @strawberry.field
    def mis_notificaciones(self, info: Info) -> List[Notificacion]:
        # Extrae los datos del cliente logueado a traves del token JWT
        user_jwt = requerir_autenticacion(info)
        user_id = user_jwt.get("sub", "")

        # Filtra para que no vea mensajes de otros clientes
        mis = [
            formatear_notificacion(n)
            for n in NOTIFICACIONES_DB
            if n["usuarioId"] == user_id
        ]
        return mis


# ==============================================================================
# MUTACIONES DEL SERVICIO DE NOTIFICACIONES
# ==============================================================================

@strawberry.type
class OperacionNotificacionRespuesta:
    """Respuesta estructurada para operaciones de eliminación en el servicio de notificaciones."""
    exito: bool
    mensaje: str
    eliminadas: Optional[int] = 0


@strawberry.type
class NotificacionesMutations:
    #Mutaciones GraphQL del Servicio de Notificaciones:

    @strawberry.mutation
    def eliminar_notificacion(self, info: Info, id: strawberry.ID) -> OperacionNotificacionRespuesta:
        """
        Elimina una notificación específica garantizando el control de acceso        """
        user_jwt = requerir_autenticacion(info)
        user_id = user_jwt.get("sub", "")
        rol = user_jwt.get("rol", "")
        notif_id = str(id)

        target = next((n for n in NOTIFICACIONES_DB if n["id"] == notif_id), None)
        if not target:
            return OperacionNotificacionRespuesta(
                exito=False,
                mensaje=f"No se encontró la notificación con ID {notif_id}.",
                eliminadas=0
            )

        if rol != "administrador" and target["usuarioId"] != user_id:
            registrar_evento(
                usuario_id=user_id,
                usuario_nombre=user_jwt.get("nombre", ""),
                rol=rol,
                servicio="Notificaciones",
                accion="INTENTO_ELIMINAR_NOTIF_AJENA",
                estado="DENEGADO",
                detalle=f"Intento no autorizado de eliminar notificación ajena {notif_id}"
            )
            raise PermissionError("Autorización denegada: No puedes eliminar notificaciones ajenas.")

        exito = eliminar_notificacion_db(notif_id, None if rol == "administrador" else user_id)

        registrar_evento(
            usuario_id=user_id,
            usuario_nombre=user_jwt.get("nombre", ""),
            rol=rol,
            servicio="Notificaciones",
            accion="ELIMINAR_NOTIFICACION",
            estado="EXITO" if exito else "FALLIDO",
            detalle=f"Notificación {notif_id} eliminada por {rol}"
        )

        return OperacionNotificacionRespuesta(
            exito=exito,
            mensaje="Notificación eliminada correctamente de tu bandeja." if exito else "No se pudo eliminar la notificación.",
            eliminadas=1 if exito else 0
        )

    @strawberry.mutation
    def limpiar_notificaciones(self, info: Info, todas: Optional[bool] = False) -> OperacionNotificacionRespuesta:
        """
        Limpia las notificaciones:
        - Si el usuario es administrador, vacía el historial completo del sistema.
        - Si el usuario es huésped/cliente, vacía únicamente su bandeja de entrada personal.
        """
        user_jwt = requerir_autenticacion(info)
        user_id = user_jwt.get("sub", "")
        rol = user_jwt.get("rol", "")
        nombre = user_jwt.get("nombre", "")

        if rol == "administrador":
            eliminadas = limpiar_todas_notificaciones_db()
            detalle = f"Administrador {nombre} vació el historial completo ({eliminadas} notificaciones eliminadas)"
            msg = f"Se vació el historial completo ({eliminadas} notificaciones eliminadas)."
        else:
            eliminadas = limpiar_notificaciones_db(user_id)
            detalle = f"Huésped {nombre} vació su bandeja personal ({eliminadas} notificaciones eliminadas)"
            msg = f"Se eliminaron {eliminadas} notificaciones de tu bandeja."

        registrar_evento(
            usuario_id=user_id,
            usuario_nombre=nombre,
            rol=rol,
            servicio="Notificaciones",
            accion="LIMPIAR_NOTIFICACIONES",
            estado="EXITO",
            detalle=detalle
        )

        return OperacionNotificacionRespuesta(
            exito=True,
            mensaje=msg,
            eliminadas=eliminadas
        )


# ==============================================================================
# HANDLERS Y CONSUMIDORES DE EVENTOS DEL BUS DE MENSAJES (BROKER ASÍNCRONO)
# ==============================================================================

def despachar_notificacion(usuario_id: str, canal: str, asunto: str, mensaje: str, evento_origen: str):
    """
    Construye la notificación, la guarda en memoria/MySQL y registra el evento en auditoría.
    """
    # Obtener correo del usuario
    destinatario = "cliente@hotel.com"
    u = USUARIOS_DB.get(usuario_id)
    if u and u.get("correo"):
        destinatario = u["correo"]

    notif_id = f"notif-{uuid.uuid4().hex[:6]}"
    fecha_envio = datetime.now().isoformat()

    nueva_notif = {
        "id": notif_id,
        "usuarioId": usuario_id,
        "canal": canal,
        "destinatario": destinatario,
        "asunto": asunto,
        "mensaje": mensaje,
        "eventoOrigen": evento_origen,
        "fechaEnvio": fecha_envio,
        "estado": "ENVIADO"
    }

    guardar_notificacion_db(nueva_notif)

    # Imprimir log del despacho
    print(f"[SERVICIO DE NOTIFICACIONES] [{canal}] >> Destino: {destinatario} | Asunto: {asunto}")

    # Contabilización AAA
    registrar_evento(
        usuario_id=usuario_id,
        usuario_nombre=u.get("nombre", "Usuario") if u else "Sistema",
        rol=u.get("rol", "cliente") if u else "sistema",
        servicio="Notificaciones",
        accion="NOTIFICACION_ENVIADA",
        estado="EXITO",
        detalle=f"{canal} enviado a {destinatario} con motivo del evento '{evento_origen}'"
    )


def consumidor_reservacion_creada(evento_dict: dict):
    """
    Consumidor del evento 'ReservacionCreada':
    Dispara email/SMS informando que la reserva está registrada y en espera de pago.
    """
    datos = evento_dict.get("datos", {})
    usuario_id = datos.get("usuarioId")
    folio = datos.get("folio", "RES-XXXX")
    total = datos.get("total", 0.0)

    asunto = f"Reservación Registrada {folio} (Pendiente de Pago)"
    mensaje = (
        f"Hola, tu reservación con folio {folio} ha sido creada por un total de ${total:,.2f} MXN. "
        f"Por favor realiza el pago en la pasarela para confirmar tu reservación."
    )
    despachar_notificacion(usuario_id, "EMAIL", asunto, mensaje, EVENTO_RESERVACION_CREADA)


def consumidor_pago_confirmado(evento_dict: dict):
    """
    Consumidor del evento 'PagoConfirmado':
    Dispara confirmación de pago y folio oficial de estancia asegurada.
    """
    datos = evento_dict.get("datos", {})
    usuario_id = datos.get("usuarioId")
    folio = datos.get("folio", "RES-XXXX")
    comprobante = datos.get("comprobante", "PAG-XXXX")
    monto = datos.get("monto", 0.0)

    asunto = f"¡Pago Confirmado! Reservación {folio} 100% Asegurada"
    mensaje = (
        f"¡Enhorabuena! Tu pago de ${monto:,.2f} MXN fue aprobado con el comprobante {comprobante}. "
        f"Tu estancia con folio {folio} ha sido confirmada satisfactoriamente en el sistema."
    )
    despachar_notificacion(usuario_id, "EMAIL", asunto, mensaje, EVENTO_PAGO_CONFIRMADO)


def consumidor_reservacion_cancelada(evento_dict: dict):
    """
    Consumidor del evento 'ReservacionCancelada':
    Informa al huésped sobre la anulación de su estancia.
    """
    datos = evento_dict.get("datos", {})
    usuario_id = datos.get("usuarioId")
    folio = datos.get("folio", "RES-XXXX")
    total = datos.get("total", 0.0)

    asunto = f"Aviso de Cancelación de Reservación {folio}"
    mensaje = (
        f"Te informamos que tu reservación con folio {folio} ha sido cancelada exitosamente. "
        f"Si realizaste un pago previo, el reembolso se procesará de inmediato."
    )
    despachar_notificacion(usuario_id, "EMAIL", asunto, mensaje, EVENTO_RESERVACION_CANCELADA)


def consumidor_pago_reembolsado(evento_dict: dict):
    """
    Consumidor del evento 'PagoReembolsado':
    Informa al huésped sobre el reintegro de su dinero.
    """
    datos = evento_dict.get("datos", {})
    usuario_id = datos.get("usuarioId")
    monto = datos.get("monto", 0.0)
    motivo = datos.get("motivo", "Cancelación")

    asunto = f"Comprobante de Reembolso por ${monto:,.2f} MXN"
    mensaje = (
        f"Se ha emitido el reembolso de tu pago por ${monto:,.2f} MXN. "
        f"Motivo: {motivo}. El saldo se verá reflejado según tu entidad bancaria."
    )
    despachar_notificacion(usuario_id, "SMS", asunto, mensaje, EVENTO_PAGO_REEMBOLSADO)


# ==============================================================================
# SUSCRIPCIÓN EN EL BUS DE MENSAJES (PATRÓN PUB/SUB SEGÚN PÁGINA 6)
# ==============================================================================
event_bus.suscribir(EVENTO_RESERVACION_CREADA, consumidor_reservacion_creada)
event_bus.suscribir(EVENTO_PAGO_CONFIRMADO, consumidor_pago_confirmado)
event_bus.suscribir(EVENTO_RESERVACION_CANCELADA, consumidor_reservacion_cancelada)
event_bus.suscribir(EVENTO_PAGO_REEMBOLSADO, consumidor_pago_reembolsado)
