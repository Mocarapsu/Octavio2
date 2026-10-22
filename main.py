# pyrefly: ignore [missing-import]
from fastapi import FastAPI, Request
# pyrefly: ignore [missing-import]
from fastapi.staticfiles import StaticFiles
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
from strawberry.fastapi import GraphQLRouter
from security import verificar_token
from schema import schema
import uvicorn
import os

# ==============================================================================
# CONTEXTO HTTP PARA GRAPHQL (EXTRACCIÓN DE TOKEN Y AUTENTICACIÓN)
# ==============================================================================

async def get_context(request: Request):
    """
    1. AUTENTICACIÓN (Triple A):
    Intercepta cada petición entrante y extrae el token JWT desde:
    - Header 'Authorization: Bearer <token>'
    - Header alternativo 'X-Access-Token'
    - Query parameter '?token=<token>'
    Decodifica el usuario y lo inyecta en el contexto de GraphQL.
    """
    auth_header = request.headers.get("Authorization") or request.headers.get("authorization") or ""
    token = ""
    
    if auth_header.startswith("Bearer "):
        token = auth_header.replace("Bearer ", "").strip()
    elif auth_header:
        token = auth_header.strip()
        
    if not token:
        token = request.headers.get("X-Access-Token", "") or request.query_params.get("token", "")

    user = None
    if token:
        user = verificar_token(token)

    return {
        "request": request,
        "token": token,
        "user": user
    }

# ==============================================================================
# INICIALIZACIÓN DE LA APLICACIÓN FASTAPI
# ==============================================================================

app = FastAPI(
    title="Sistema de Reservaciones SOA / SaaS - Triple A",
    description="Implementación de los servicios de Usuarios y Reservaciones con Autenticación, Autorización y Contabilización (AAA).",
    version="1.0.0"
)

# Permitir CORS para desarrollo y pruebas
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Middleware para visualizar en tiempo real en la terminal las peticiones que haga Alan
@app.middleware("http")
async def log_solicitudes_externas(request: Request, call_next):
    client_ip = request.client.host if request.client else "127.0.0.1"
    metodo = request.method
    ruta = request.url.path
    
    # Filtrar archivos estáticos para que solo se muestren peticiones de datos
    if not any(ruta.endswith(ext) for ext in [".css", ".js", ".png", ".jpg", ".jpeg", ".ico", ".svg", ".woff2"]):
        print(f"\n📡 [PETICIÓN ENTRANTE] {metodo} {ruta} | Desde IP: {client_ip}")

    response = await call_next(request)
    return response

# Router GraphQL con Strawberry
graphql_app = GraphQLRouter(schema, context_getter=get_context)
app.include_router(graphql_app, prefix="/graphql")

# ==============================================================================
# ENDPOINTS REST DEL PUENTE SOA (INTEGRACIÓN TIENDA ONLINE / ALAN NGROK)
# ==============================================================================
from services.tienda_bridge import (  # type: ignore
    verificar_conexion_tienda,
    cargar_config_tienda,
    guardar_config_tienda,
    cobrar_en_tienda,
    reembolsar_en_tienda,
    enviar_notificacion_tienda
)

@app.get("/api/tienda/estado", tags=["Puente SOA"])
async def api_tienda_estado():
    """Verifica la conectividad en vivo con el microservicio Ngrok de Alan."""
    return verificar_conexion_tienda()

@app.get("/api/tienda/configuracion", tags=["Puente SOA"])
async def api_tienda_obtener_config():
    """Retorna la configuración actual del microservicio externo."""
    return cargar_config_tienda()

@app.post("/api/tienda/configuracion", tags=["Puente SOA"])
async def api_tienda_actualizar_config(payload: dict):
    """Permite actualizar la URL de Ngrok en caliente si el compañero reinicia su túnel."""
    nueva_url = payload.get("ngrok_url", "")
    if not nueva_url:
        return {"exito": False, "mensaje": "Se requiere el campo 'ngrok_url'."}
    cfg = guardar_config_tienda(nueva_url)
    return {"exito": True, "mensaje": "URL de Ngrok actualizada con éxito.", "configuracion": cfg}

@app.post("/api/tienda/test-cobro", tags=["Puente SOA"])
async def api_tienda_test_cobro(payload: dict):
    """Endpoint REST de prueba directa para invocar el microservicio de pagos de Alan."""
    res = cobrar_en_tienda(
        user_id=payload.get("user_id", "cliente-101"),
        reservation_id=payload.get("reservation_id", "RES-2026-TEST"),
        concept=payload.get("concept", "Prueba de Integración SOA"),
        amount=float(payload.get("amount", 1500.0)),
        payment_type=payload.get("payment_type", "TOTAL"),
        payment_method=payload.get("payment_method", "CREDIT_CARD"),
        recipient_email=payload.get("recipient_email", "cliente@correo.com"),
        card_details=payload.get("card_details")
    )
    return res

@app.post("/api/tienda/test-notificacion", tags=["Puente SOA"])
async def api_tienda_test_notificacion(payload: dict):
    """Endpoint REST de prueba directa para invocar las notificaciones de Alan."""
    res = enviar_notificacion_tienda(
        user_id=payload.get("user_id", "cliente-101"),
        recipient_email=payload.get("recipient_email", "cliente@correo.com"),
        tipo=payload.get("type", "RESERVATION_CONFIRMATION"),
        reservation_id=payload.get("reservation_id", "RES-2026-TEST"),
        total=float(payload.get("total", 1500.0)),
        subject=payload.get("subject"),
        message=payload.get("message")
    )
    return res

from services.tienda_bridge import crear_resena_en_tienda, obtener_resenas_tienda  # type: ignore
from data.db import obtener_resenas_db, guardar_resena_db  # type: ignore
from event_bus import event_bus, EVENTO_RESENA_CREADA  # type: ignore
from datetime import datetime
from typing import Optional
import uuid

@app.get("/api/resenas", tags=["Reseñas"])
@app.get("/api/tienda/resenas", tags=["Puente SOA"])
async def api_tienda_obtener_resenas(item_id: Optional[str] = None):
    """Consulta las opiniones registradas tanto localmente como en el servicio de Alan."""
    return {
        "recurso_id": item_id,
        "resenas_locales": obtener_resenas_db(item_id),
        "servicio_externo": obtener_resenas_tienda(item_id)
    }

@app.post("/api/resenas", tags=["Reseñas"])
async def api_crear_resena_rest(payload: dict):
    """
    Publica una reseña en el sistema del hotel y la sincroniza en vivo con el microservicio de Alan.
    """
    item_id = str(payload.get("item_id") or payload.get("recurso_id") or "r-12")
    user_id = str(payload.get("user_id", "cliente-101"))
    user_name = str(payload.get("user_name", "Huésped Hotel"))
    rating = int(payload.get("rating") or payload.get("calificacion", 5))
    title = str(payload.get("title") or payload.get("titulo", "Excelente estancia"))
    comment = str(payload.get("comment") or payload.get("comentario", ""))
    reservation_id = str(payload.get("reservation_id") or payload.get("reservacion_id", ""))
    images = payload.get("images") or payload.get("imagenes") or []

    # 1. Enviar al microservicio de Alan (Ngrok)
    resp_alan = crear_resena_en_tienda(
        user_id=user_id,
        user_name=user_name,
        item_id=item_id,
        rating=rating,
        title=title,
        comment=comment,
        reservation_id=reservation_id,
        images=images
    )

    # 2. Guardar en base de datos local
    nueva_resena = {
        "id": f"res-{uuid.uuid4().hex[:8]}",
        "recursoId": item_id,
        "usuarioId": user_id,
        "usuarioNombre": user_name,
        "calificacion": rating,
        "titulo": title,
        "comentario": comment,
        "imagenes": images,
        "fecha": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "reservacionId": reservation_id,
        "servicioExterno": "Tienda Online Alan (Interactions)",
        "reviewIdExterno": resp_alan.get("review_id", "")
    }
    guardar_resena_db(nueva_resena)

    # 3. Notificar en bus de eventos
    event_bus.publish(EVENTO_RESENA_CREADA, nueva_resena)

    return {
        "exito": True,
        "mensaje": "Reseña registrada y sincronizada exitosamente.",
        "resena": nueva_resena,
        "servicio_externo": resp_alan
    }

@app.post("/api/tienda/test-resena", tags=["Puente SOA"])
async def api_tienda_test_resena(payload: dict):
    """Prueba REST para publicar una reseña directamente en el microservicio en Go de Alan."""
    return crear_resena_en_tienda(
        user_id=payload.get("user_id", "cliente-101"),
        user_name=payload.get("user_name", "Juan Pérez"),
        item_id=payload.get("item_id") or payload.get("product_id", "r-12"),
        rating=int(payload.get("rating", 5)),
        title=payload.get("title", "Excelente estancia"),
        comment=payload.get("comment", "Habitación sumamente cómoda y limpia."),
        reservation_id=payload.get("reservation_id", ""),
        images=payload.get("images") or payload.get("imagenes") or []
    )

# Directorio de archivos estáticos para la interfaz web moderna
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

if __name__ == "__main__":
    print("\n" + "="*70)
    print("[INICIANDO] SISTEMA DE RESERVACIONES SOA / SAAS (UNIDAD 3 - TRIPLE A)")
    print("="*70)
    print("  -> Interfaz Web Interactiva: http://localhost:8000")
    print("  -> GraphQL Playground:       http://localhost:8000/graphql")
    print("="*70 + "\n")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)