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

MÓDULO: BUS DE MENSAJES Y EVENTOS ASÍNCRONOS (BROKER / ESB)
Archivo: event_bus.py
================================================================================
DESCRIPCIÓN GENERAL:
Este módulo implementa el Bus de Mensajes empresarial (ESB / Message Broker)
especificado en las secciones 3 y 4 del documento de arquitectura de Octavio
(equivalente conceptual a RabbitMQ o Apache Kafka):

1. DESACOPLAMIENTO ASÍNCRONO:
   - Permite que los servicios publiquen eventos sin conocer directamente a los
     consumidores (Loose Coupling propio de SOA).
   - Patrón Publicador / Suscriptor (Pub/Sub).

2. FLUJO DE EVENTOS ESPECIFICADO EN EL DOCUMENTO:
   - Evento 'ReservacionCreada':
     * Emitido por: Servicio de Reservaciones al registrar una nueva reserva (estado PENDIENTE).
     * Consumido por: Servicio de Notificaciones (envía correo/SMS con folio al cliente).
   - Evento 'PagoConfirmado':
     * Emitido por: Servicio de Pagos cuando la pasarela aprueba la transacción.
     * Consumido por:
       1. Servicio de Reservaciones (cambia estado de PENDIENTE a CONFIRMADA).
       2. Servicio de Notificaciones (envía comprobante de pago por correo/SMS).
   - Evento 'ReservacionCancelada':
     * Emitido por: Servicio de Reservaciones al anular una estancia.
     * Consumido por:
       1. Servicio de Pagos (procesa reembolso económico si estaba pagada).
       2. Servicio de Notificaciones (avisa al cliente sobre la cancelación).
   - Evento 'PagoReembolsado':
     * Emitido por: Servicio de Pagos tras emitir el reintegro.
     * Consumido por: Servicio de Notificaciones (notifica reembolso al cliente).
================================================================================
"""

import sys
import os
import uuid
from datetime import datetime
from typing import Callable, Dict, List, Any

# Garantizar que la raíz del proyecto esté en el PYTHONPATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), ".")))

# ==============================================================================
# NOMBRES DE EVENTOS ESTANDARIZADOS SEGÚN EL DOCUMENTO DE OCTAVIO
# ==============================================================================
EVENTO_RESERVACION_CREADA = "ReservacionCreada"
EVENTO_PAGO_CONFIRMADO = "PagoConfirmado"
EVENTO_RESERVACION_CANCELADA = "ReservacionCancelada"
EVENTO_PAGO_REEMBOLSADO = "PagoReembolsado"
EVENTO_RECURSO_CREADO = "RecursoCreado"
EVENTO_RECURSO_ACTUALIZADO = "RecursoActualizado"
EVENTO_RECURSO_ELIMINADO = "RecursoEliminado"
EVENTO_RESENA_CREADA = "ResenaCreada"


class EventBus:
    """
    Bus de Servicios Empresariales (ESB) en memoria con registro de auditoría.
    Gestiona suscripciones y despacha eventos entre microservicios.
    """
    def __init__(self):
        # Mapeo: nombre_evento -> lista de callbacks/suscriptores
        self._suscriptores: Dict[str, List[Callable[[Dict[str, Any]], None]]] = {}
        # Historial de eventos despachados para monitoreo y depuración
        self.historial_eventos: List[Dict[str, Any]] = []

    def suscribir(self, evento: str, handler: Callable[[Dict[str, Any]], None]):
        """
        Registra una función suscriptora para un tipo de evento específico.
        """
        if evento not in self._suscriptores:
            self._suscriptores[evento] = []
        self._suscriptores[evento].append(handler)

    def publicar(self, evento: str, datos: Dict[str, Any]):
        """
        Publica un evento en el bus y notifica de manera desacoplada a todos los
        suscriptores registrados.
        """
        evento_id = f"evt-{uuid.uuid4().hex[:8]}"
        timestamp = datetime.now().isoformat()

        registro_evento = {
            "id": evento_id,
            "evento": evento,
            "timestamp": timestamp,
            "datos": datos
        }
        self.historial_eventos.append(registro_evento)

        # Imprimir en consola para visualizar el flujo asíncrono
        print(f"[BUS DE MENSAJES] >> Evento publicado: '{evento}' (ID: {evento_id})")

        # Despachar a cada suscriptor registrado
        handlers = self._suscriptores.get(evento, [])
        for handler in handlers:
            try:
                handler(registro_evento)
            except Exception as e:
                print(f"[BUS DE MENSAJES ERROR] Falló suscriptor de '{evento}': {e}")

    def publish(self, evento: str, datos: Dict[str, Any]):
        """Alias en inglés para publicar."""
        return self.publicar(evento, datos)

    def subscribe(self, evento: str, handler: Callable[[Dict[str, Any]], None]):
        """Alias en inglés para suscribir."""
        return self.suscribir(evento, handler)


# Instancia singleton del Bus de Mensajes accesible para todos los servicios
event_bus = EventBus()
