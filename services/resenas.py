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

MÓDULO: SERVICIO DE RESEÑAS Y VALORACIONES (INTERACCIONES SOA / TIENDA ONLINE)
Archivo: services/resenas.py
================================================================================
DESCRIPCIÓN GENERAL:
Este microservicio implementa la gestión de opiniones, comentarios y calificaciones
(Reviews / Rating de 1 a 5 estrellas) para las habitaciones y recursos del hotel.

INTEGRACIÓN ARQUITECTÓNICA (PATRÓN ADAPTER / API GATEWAY):
- Expone un esquema GraphQL limpio y tipado hacia el cliente web del hotel.
- Consume de forma desacoplada el microservicio REST de Interacciones de la
  Tienda Online de Alan López Medina:
    POST /api/interactions/reviews
    GET  /api/interactions/reviews?item_id=...
- Implementa el Modelo Triple A (Autenticación JWT, Autorización y Contabilización).
================================================================================
"""

import sys
import os
import uuid
import json
from datetime import datetime
from typing import Optional, List

# Garantizar que la raíz del proyecto esté en el PYTHONPATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import strawberry  # type: ignore
from strawberry.types import Info  # type: ignore

from data.db import (  # type: ignore
    RESENAS_DB,
    RECURSOS_DB,
    USUARIOS_DB,
    guardar_resena_db,
    obtener_resenas_db
)
from security import (  # type: ignore
    requerir_autenticacion,
    requerir_autorizacion,
    obtener_usuario_actual
)
from accounting import registrar_evento  # type: ignore
from event_bus import (  # type: ignore
    event_bus,
    EVENTO_RESENA_CREADA
)
from services.tienda_bridge import (  # type: ignore
    crear_resena_en_tienda,
    obtener_resenas_tienda
)


# ==============================================================================
# TIPOS GRAPHQL PARA RESEÑAS Y VALORACIONES
# ==============================================================================

@strawberry.type
class Resena:
    """
    Representa una reseña/calificación emitida por un huésped.
    """
    id: strawberry.ID
    recurso_id: strawberry.ID
    usuario_id: strawberry.ID
    usuario_nombre: str
    calificacion: int
    titulo: str
    comentario: str
    fecha: str
    reservacion_id: Optional[str] = None
    servicio_externo: Optional[str] = "Tienda Online Alan (Interactions)"
    review_id_externo: Optional[str] = None
    imagenes: List[str] = strawberry.field(default_factory=list)


@strawberry.type
class ResumenResenas:
    """
    Resumen consolidado de calificaciones y promedio de una habitación.
    """
    recurso_id: strawberry.ID
    promedio: float
    total: int
    resenas: List[Resena]


@strawberry.input
class CrearResenaInput:
    """
    Datos de entrada para publicar una reseña desde el cliente web.
    """
    recurso_id: strawberry.ID
    calificacion: int  # 1 a 5 estrellas
    titulo: str
    comentario: str
    reservacion_id: Optional[str] = None
    imagenes: Optional[List[str]] = None


def formatear_resena(r: dict) -> Resena:
    comentario = r.get("comentario", "") or r.get("comment", "")
    fotos = r.get("imagenes") or r.get("images") or []
    if not fotos and " |||IMAGES|||" in str(comentario):
        partes = str(comentario).split(" |||IMAGES|||", 1)
        comentario = partes[0].strip()
        try:
            parsed = json.loads(partes[1])
            if isinstance(parsed, list):
                fotos = parsed
        except Exception:
            pass

    return Resena(
        id=strawberry.ID(str(r.get("id") or r.get("review_id") or "")),
        recurso_id=strawberry.ID(str(r.get("recursoId") or r.get("item_id") or r.get("product_id") or "")),
        usuario_id=strawberry.ID(str(r.get("usuarioId") or r.get("user_id") or "")),
        usuario_nombre=r.get("usuarioNombre") or r.get("user_name") or "Huésped",
        calificacion=int(r.get("calificacion") or r.get("rating") or 5),
        titulo=r.get("titulo") or r.get("title") or "Excelente estancia",
        comentario=comentario,
        fecha=r.get("fecha") or r.get("created_at") or "",
        reservacion_id=r.get("reservacionId") or r.get("reservation_id"),
        servicio_externo=r.get("servicioExterno") or "Tienda Online Alan (Interactions)",
        review_id_externo=r.get("reviewIdExterno") or r.get("review_id"),
        imagenes=fotos
    )


# QUERIES DEL SERVICIO DE RESEÑAS
@strawberry.type
class ResenasQueries:

    @strawberry.field
    def resenas(
        self,
        info: Info,
        recurso_id: Optional[strawberry.ID] = None
    ) -> List[Resena]:
        """
        Consulta las opiniones de una habitación específica o todas las del hotel.
        """
        rec_id_str = str(recurso_id) if recurso_id else None
        lista = obtener_resenas_db(rec_id_str)
        # Ordenar por fecha descendente
        lista_ordenada = sorted(lista, key=lambda x: x.get("fecha", ""), reverse=True)
        return [formatear_resena(r) for r in lista_ordenada]

    @strawberry.field
    def resumen_resenas(
        self,
        info: Info,
        recurso_id: strawberry.ID
    ) -> ResumenResenas:
        """
        Calcula el promedio de estrellas y agrupa las opiniones de un recurso.
        """
        rec_id_str = str(recurso_id)
        # Sincronizar opiniones remotas de Alan si existen
        try:
            data_tienda = obtener_resenas_tienda(rec_id_str)
            for r_ext in data_tienda.get("reviews", []):
                ext_id = str(r_ext.get("review_id") or r_ext.get("id") or "")
                if ext_id and not any(r.get("reviewIdExterno") == ext_id or r.get("id") == ext_id for r in RESENAS_DB.values()):
                    RESENAS_DB[f"ext-{ext_id}"] = {
                        "id": f"ext-{ext_id}",
                        "recursoId": rec_id_str,
                        "usuarioId": r_ext.get("user_id", "cliente-ext"),
                        "usuarioNombre": r_ext.get("user_name", "Huésped"),
                        "reservacionId": "",
                        "calificacion": int(r_ext.get("rating", 5)),
                        "titulo": r_ext.get("title", "Opinión"),
                        "comentario": r_ext.get("comentario", ""),
                        "imagenes": r_ext.get("imagenes", []),
                        "fecha": r_ext.get("created_at", datetime.now().isoformat()),
                        "servicioExterno": "Tienda Online Alan (Remoto)",
                        "reviewIdExterno": ext_id
                    }
        except Exception:
            pass

        lista = [r for r in RESENAS_DB.values() if r.get("recursoId") == rec_id_str]

        if not lista:
            return ResumenResenas(
                recurso_id=recurso_id,
                promedio=5.0,
                total=0,
                resenas=[]
            )

        promedio = sum(int(r.get("calificacion", 5)) for r in lista) / len(lista)
        lista_ordenada = sorted(lista, key=lambda x: x.get("fecha", ""), reverse=True)

        return ResumenResenas(
            recurso_id=recurso_id,
            promedio=round(promedio, 1),
            total=len(lista),
            resenas=[formatear_resena(r) for r in lista_ordenada]
        )


# ==============================================================================
# MUTATIONS DEL SERVICIO DE RESEÑAS
# ==============================================================================

@strawberry.type
class ResenasMutations:

    @strawberry.mutation
    def crear_resena(
        self,
        info: Info,
        input: CrearResenaInput
    ) -> Resena:
        """
        Publica una nueva reseña:
        1. Autenticación Triple A (Exige JWT de huésped o admin).
        2. Validación de reglas de negocio (Calificación del 1 al 5).
        3. Invoca el microservicio REST de Alan mediante el puente SOA con fotos opcionales.
        4. Persiste en MySQL y memoria.
        5. Registra auditoría (Accounting AAA) y emite evento al Bus.
        """
        # 1. Autenticación AAA
        user_jwt = requerir_autenticacion(info)
        user_id = user_jwt.get("sub", "")
        user_nombre = user_jwt.get("nombre", "Huésped")
        rol = user_jwt.get("rol", "cliente")

        # 2. Validación de calificación
        calif = max(1, min(5, int(input.calificacion)))
        rec_id = str(input.recurso_id)

        # 3. Validación de recurso existente
        recurso = RECURSOS_DB.get(rec_id)
        nombre_recurso = recurso.get("nombre", rec_id) if recurso else rec_id

        # 4. Invocación del microservicio REST de Tienda Online (Alan López)
        fotos = input.imagenes if (input.imagenes and isinstance(input.imagenes, list)) else []

        res_externa = crear_resena_en_tienda(
            user_id=user_id,
            user_name=user_nombre,
            item_id=rec_id,
            rating=calif,
            title=input.titulo.strip(),
            comment=input.comentario.strip(),
            reservation_id=str(input.reservacion_id) if input.reservacion_id else None,
            images=fotos
        )

        review_id_externo = res_externa.get("review_id", f"rev-{uuid.uuid4().hex[:6]}")
        origen_servicio = res_externa.get("origen_servicio", "PUENTE_SOA")

        # 5. Generación de registro local
        resena_id = f"rev-{uuid.uuid4().hex[:6]}"
        fecha_resena = datetime.now().isoformat()

        nueva_resena = {
            "id": resena_id,
            "recursoId": rec_id,
            "usuarioId": user_id,
            "usuarioNombre": user_nombre,
            "reservacionId": str(input.reservacion_id) if input.reservacion_id else "",
            "calificacion": calif,
            "titulo": input.titulo.strip(),
            "comentario": input.comentario.strip(),
            "imagenes": fotos,
            "fecha": fecha_resena,
            "servicioExterno": f"Tienda Online Alan ({origen_servicio})",
            "reviewIdExterno": review_id_externo
        }

        # 6. Persistencia en MySQL y RAM
        RESENAS_DB[resena_id] = nueva_resena
        try:
            guardar_resena_db(nueva_resena)
        except Exception:
            pass

        # 7. Bus de Mensajes: Despacha evento ResenaCreada
        event_bus.publicar(EVENTO_RESENA_CREADA, {
            "resenaId": resena_id,
            "recursoId": rec_id,
            "usuarioId": user_id,
            "calificacion": calif,
            "titulo": input.titulo,
            "reviewIdExterno": review_id_externo
        })

        # 8. Contabilización AAA (Accounting)
        registrar_evento(
            usuario_id=user_id,
            usuario_nombre=user_nombre,
            rol=rol,
            servicio="Reseñas",
            accion="CREAR_RESENA",
            estado="EXITO",
            detalle=f"Reseña de {calif} estrellas publicada para '{nombre_recurso}'. Ref Tienda: {review_id_externo}",
            monto=0.0
        )

        print(f"[SERVICIO DE RESEÑAS] [OK] Reseña registrada para '{nombre_recurso}' ({calif} estrellas)")

        return formatear_resena(nueva_resena)
