// ==============================================================================
// HOTEL PARAÍSO - CLIENTE JAVASCRIPT CON 5 MICROSERVICIOS Y MODELO TRIPLE A
// ==============================================================================

const app = {
  token: "",
  currentUser: null,
  allHoteles: [],
  allRecursos: [],
  selectedRecurso: null,
  selectedHotelId: "TODOS",
  pendingRecursoId: null,
  adminGlobalVisible: false,
  adminReservacionesList: [],
  adminStatusFilter: "TODAS",
  adminViewMode: "pms",
  adminSelectedHotelId: "TODAS",
  adminRoomStateFilter: "TODAS",
  notifCategoryFilter: "TODAS",
  allNotificacionesList: [],
  timerIntervalId: null,
  activePaymentReserva: null,
  currentModalHotelId: null,

  async init() {
    console.log("Iniciando Hotel Paraíso con 5 Microservicios (SOA / SaaS)...");

    this.initDefaultDates();
    this.iniciarTemporizadorGlobal();
    this.actualizarUIUsuario();

    // Cargar hoteles y catálogo
    await this.cargarHoteles();
    await this.cargarRecursos();

    // Cargar auditoría contable (si es admin) o general
    await this.cargarContabilizacion();
    await this.cargarEstadoPuente();
  },

  initDefaultDates() {
    const hoy = new Date();
    const salida = new Date();
    salida.setDate(hoy.getDate() + 3);

    const fHoy = hoy.toISOString().split("T")[0];
    const fSalida = salida.toISOString().split("T")[0];

    const inEl = document.getElementById("searchCheckIn");
    const outEl = document.getElementById("searchCheckOut");
    if (inEl && !inEl.value) inEl.value = fHoy;
    if (outEl && !outEl.value) outEl.value = fSalida;

    const modalIn = document.getElementById("modalFechaInicio");
    const modalOut = document.getElementById("modalFechaFin");
    if (modalIn) modalIn.value = inEl ? inEl.value : fHoy;
    if (modalOut) modalOut.value = outEl ? outEl.value : fSalida;
  },

  // Consulta al API Gateway GraphQL
  async graphql(query, variables = {}) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    try {
      const isPort8000 = window.location.port === "8000";
      const endpoint = isPort8000 ? "/graphql" : "http://localhost:8000/graphql";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ query, variables })
      });
      return await response.json();
    } catch (err) {
      console.error("Error de red con el API Gateway GraphQL:", err);
      this.showToast("Error de conexión con el servidor (Asegúrate de ejecutar iniciar_servidor.bat)", "error");
      return { errors: [{ message: err.message }] };
    }
  },

  // ==============================================================================
  // 1. GESTIÓN DE USUARIOS Y AUTENTICACIÓN (SERVICIO 1)
  // ==============================================================================
  async quickLogin(correo, password) {
    const query = `
      mutation IniciarSesion($correo: String!, $password: String!) {
        iniciarSesion(correo: $correo, password: $password) {
          token
          mensaje
          exito
          usuario {
            id
            nombre
            correo
            rol
          }
        }
      }
    `;

    const res = await this.graphql(query, { correo, password });

    if (res.data?.iniciarSesion?.exito) {
      const payload = res.data.iniciarSesion;
      this.token = payload.token;
      this.currentUser = payload.usuario;

      this.actualizarUIUsuario();
      this.showToast(`Bienvenido, ${this.currentUser.nombre}`, "success");
      this.closeModal("authModal");

      // Si había una reserva en espera de inicio de sesión
      if (this.pendingRecursoId) {
        const recId = this.pendingRecursoId;
        this.pendingRecursoId = null;
        this.openBookingModal(recId);
      }

      await this.cargarMisReservaciones();
      await this.cargarNotificacionesCount();
      await this.cargarContabilizacion();
    } else {
      const errorMsg = res.errors?.[0]?.message || res.data?.iniciarSesion?.mensaje || "Credenciales incorrectas";
      this.showToast(errorMsg, "error");
    }
  },

  async handleManualLogin(e) {
    e.preventDefault();
    const correo = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value.trim();
    await this.quickLogin(correo, password);
  },

  async handleManualRegister(e) {
    e.preventDefault();
    const nombre = document.getElementById("regNombre").value.trim();
    const correo = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value.trim();

    const query = `
      mutation RegistrarUsuario($input: RegistroUsuarioInput!) {
        registrarUsuario(input: $input) {
          token
          mensaje
          exito
          usuario {
            id
            nombre
            correo
            rol
          }
        }
      }
    `;

    const res = await this.graphql(query, { input: { nombre, correo, password } });

    if (res.data?.registrarUsuario?.exito) {
      const payload = res.data.registrarUsuario;
      this.token = payload.token;
      this.currentUser = payload.usuario;

      this.actualizarUIUsuario();
      this.showToast("Cuenta creada exitosamente. Bienvenido.", "success");
      this.closeModal("authModal");

      if (this.pendingRecursoId) {
        const recId = this.pendingRecursoId;
        this.pendingRecursoId = null;
        this.openBookingModal(recId);
      }

      await this.cargarMisReservaciones();
      await this.cargarNotificacionesCount();
      await this.cargarContabilizacion();
    } else {
      const errorMsg = res.errors?.[0]?.message || res.data?.registrarUsuario?.mensaje || "Error al registrarse";
      this.showToast(errorMsg, "error");
    }
  },

  logout() {
    this.token = "";
    this.currentUser = null;
    this.actualizarUIUsuario();
    this.showToast("Sesión cerrada correctamente", "info");

    const misResSec = document.getElementById("mis-reservaciones");
    if (misResSec) misResSec.style.display = "none";

    document.getElementById("notifBadgeCount").textContent = "0";
    this.cargarContabilizacion();
  },

  actualizarUIUsuario() {
    const guestActions = document.getElementById("guestNavActions");
    const userActions = document.getElementById("userNavActions");
    const navLinkMisReservas = document.getElementById("navLinkMisReservas");
    const navLinkAdminPms = document.getElementById("navLinkAdminPms");
    const btnAdminNuevoRecurso = document.getElementById("btnAdminNuevoRecurso");
    const clientPortalView = document.getElementById("clientPortalView");
    const adminPortalView = document.getElementById("adminPortalView");
    const btnToggleAdminMode = document.getElementById("btnToggleAdminMode");

    if (this.currentUser) {
      guestActions.style.display = "none";
      userActions.style.display = "flex";

      document.getElementById("navUserName").textContent = this.currentUser.nombre;
      document.getElementById("navUserRole").textContent = this.currentUser.rol.toUpperCase();

      const navAvatar = document.getElementById("navAvatar");
      if (navAvatar) {
        const initials = (this.currentUser.nombre || "U")
          .split(" ")
          .filter(p => p && !p.startsWith("(") && !p.endsWith(")"))
          .slice(0, 2)
          .map(w => w[0])
          .join("")
          .toUpperCase() || "U";
        navAvatar.textContent = initials;
        if (this.currentUser.rol === "administrador") {
          navAvatar.classList.add("admin");
        } else {
          navAvatar.classList.remove("admin");
        }
      }

      const isAdmin = this.currentUser.rol === "administrador";

      if (isAdmin) {
        if (navLinkAdminPms) navLinkAdminPms.style.display = "inline-flex";
        if (navLinkMisReservas) navLinkMisReservas.style.display = "none";
        if (btnAdminNuevoRecurso) btnAdminNuevoRecurso.style.display = "inline-flex";

        if (this.adminViewMode === "pms") {
          // Vista exclusiva de Administrador: Consola PMS Backoffice
          if (clientPortalView) clientPortalView.style.display = "none";
          if (adminPortalView) adminPortalView.style.display = "block";
          if (btnToggleAdminMode) {
            btnToggleAdminMode.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <span>Ver Modo Huésped (Trivago)</span>
            `;
          }
          this.actualizarPanelAdminCompleto();
        } else {
          // Modo explorador Huésped (Trivago) para previsualización
          if (clientPortalView) clientPortalView.style.display = "block";
          if (adminPortalView) adminPortalView.style.display = "none";
          if (btnToggleAdminMode) {
            btnToggleAdminMode.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>
              <span>Volver a Consola PMS</span>
            `;
          }
        }
      } else {
        // Modo cliente normal
        this.adminViewMode = "pms";
        if (navLinkAdminPms) navLinkAdminPms.style.display = "none";
        if (navLinkMisReservas) navLinkMisReservas.style.display = "inline-flex";
        if (btnAdminNuevoRecurso) btnAdminNuevoRecurso.style.display = "none";
        if (clientPortalView) clientPortalView.style.display = "block";
        if (adminPortalView) adminPortalView.style.display = "none";
      }

      this.actualizarPanelTripleAToken();
    } else {
      // Sin sesión (Invitado)
      guestActions.style.display = "flex";
      userActions.style.display = "none";
      if (navLinkMisReservas) navLinkMisReservas.style.display = "none";
      if (navLinkAdminPms) navLinkAdminPms.style.display = "none";
      if (btnAdminNuevoRecurso) btnAdminNuevoRecurso.style.display = "none";

      this.adminViewMode = "pms";
      if (clientPortalView) clientPortalView.style.display = "block";
      if (adminPortalView) adminPortalView.style.display = "none";

      this.actualizarPanelTripleAToken();
    }
  },

  toggleAdminPortalMode() {
    this.adminViewMode = this.adminViewMode === "pms" ? "guest" : "pms";
    this.actualizarUIUsuario();
    if (this.adminViewMode === "pms") {
      this.showToast("Cambiado a Consola PMS de Gerencia", "info");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      this.showToast("Modo Huésped (Trivago) activado para explorar habitaciones", "info");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  },

  showAdminPmsView(e) {
    if (e) e.preventDefault();
    this.adminViewMode = "pms";
    this.actualizarUIUsuario();
    window.scrollTo({ top: 0, behavior: "smooth" });
  },

  // ==============================================================================
  // 2. CATÁLOGO DE RECURSOS Y HOTELES (SERVICIO 2: CATÁLOGO)
  // ==============================================================================
  async cargarHoteles() {
    const query = `
      query {
        hoteles {
          id
          nombre
          ubicacion
          descripcion
          foto
          capacidadTotal
          totalHabitaciones
          disponiblesHoy
          ocupadasHoy
          tasaOcupacion
        }
      }
    `;
    const res = await this.graphql(query);
    if (res.data?.hoteles) {
      this.allHoteles = res.data.hoteles;
      this.renderHoteles(this.allHoteles);
    }
  },

  renderHoteles(hoteles) {
    const grid = document.getElementById("hotelsGrid");
    if (!grid) return;
    grid.innerHTML = "";

    hoteles.forEach(h => {
      const card = document.createElement("div");
      card.className = "hotel-card";
      card.innerHTML = `
        <img src="${h.foto}" alt="${h.nombre}" class="hotel-card-img" loading="lazy">
        <div class="hotel-card-body">
          <h3 class="hotel-card-title">${h.nombre}</h3>
          <span class="hotel-card-location">📍 ${h.ubicacion}</span>
          <p class="hotel-card-desc">${h.descripcion}</p>

          <div class="hotel-card-badges">
            <span class="hotel-badge-item" title="Capacidad de personas simultáneas">
              👥 <strong>${h.capacidadTotal || 0}</strong> personas
            </span>
            <span class="hotel-badge-item" title="Unidades habitacionales">
              🛏️ <strong>${h.totalHabitaciones || 0}</strong> habitaciones
            </span>
            <span class="hotel-badge-item" style="color: #16a34a;" title="Disponibles hoy">
              🟢 <strong>${h.disponiblesHoy || 0}</strong> libres hoy
            </span>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px;">
            <button class="btn btn-primary btn-sm" onclick="app.openHotelDetailModal('${h.id}')">
              📊 Estadísticas y Disponibilidad
            </button>
            <button class="btn btn-secondary btn-sm" onclick="app.filterByHotel('${h.id}')">
              🛏️ Ver Habitaciones
            </button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  },

  async openHotelDetailModal(hotelId) {
    this.currentModalHotelId = hotelId;
    const hotel = this.allHoteles.find(h => h.id === hotelId);

    // Consultar estadísticas de la sucursal
    const query = `
      query ObtenerEstadisticaSede($id: ID!) {
        estadisticaHotel(hotelId: $id) {
          hotelId
          nombre
          ubicacion
          descripcion
          foto
          capacidadTotalPersonas
          totalHabitaciones
          habitacionesDisponiblesHoy
          habitacionesOcupadas
          habitacionesPendientes
          tasaOcupacion
          totalIngresos
        }
      }
    `;

    const res = await this.graphql(query, { id: hotelId });
    const stats = res.data?.estadisticaHotel || hotel || {};

    const titleEl = document.getElementById("hotelDetailModalTitle");
    const fotoEl = document.getElementById("hotelDetailFoto");
    const ubiEl = document.getElementById("hotelDetailUbicacion");
    const nomEl = document.getElementById("hotelDetailNombre");
    const descEl = document.getElementById("hotelDetailDesc");
    const capEl = document.getElementById("hotelDetailCapacidad");
    const habEl = document.getElementById("hotelDetailHabitaciones");
    const dispEl = document.getElementById("hotelDetailDisponibles");
    const ocupEl = document.getElementById("hotelDetailOcupacion");

    if (titleEl) titleEl.textContent = stats.nombre || "Sucursal Hotel Paraíso";
    if (fotoEl) fotoEl.src = stats.foto || "";
    if (ubiEl) ubiEl.textContent = stats.ubicacion || "";
    if (nomEl) nomEl.textContent = stats.nombre || "";
    if (descEl) descEl.textContent = stats.descripcion || "";
    if (capEl) capEl.textContent = `${stats.capacidadTotalPersonas || stats.capacidadTotal || 0} pers.`;
    if (habEl) habEl.textContent = `${stats.totalHabitaciones || 0} unidades`;
    if (dispEl) dispEl.textContent = `${stats.habitacionesDisponiblesHoy ?? stats.disponiblesHoy ?? 0} libres`;
    if (ocupEl) ocupEl.textContent = `${stats.tasaOcupacion || 0}%`;

    // Sincronizar fechas
    const checkIn = document.getElementById("searchCheckIn")?.value || "2026-10-18";
    const checkOut = document.getElementById("searchCheckOut")?.value || "2026-10-21";
    const mCheckIn = document.getElementById("hotelDetailCheckIn");
    const mCheckOut = document.getElementById("hotelDetailCheckOut");
    if (mCheckIn) mCheckIn.value = checkIn;
    if (mCheckOut) mCheckOut.value = checkOut;

    this.openModal("hotelDetailModal");
    await this.consultarDisponibilidadSucursal();
  },

  async consultarDisponibilidadSucursal() {
    if (!this.currentModalHotelId) return;
    const hotelId = this.currentModalHotelId;
    const desde = document.getElementById("hotelDetailCheckIn")?.value;
    const hasta = document.getElementById("hotelDetailCheckOut")?.value;
    const container = document.getElementById("hotelDetailRoomsContainer");

    if (!desde || !hasta) {
      this.showToast("Selecciona las fechas de llegada y salida", "warning");
      return;
    }

    if (container) {
      container.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #64748b;">
          <span>Consultando disponibilidad en tiempo real con MySQL...</span>
        </div>
      `;
    }

    const query = `
      query ConsultarDisponibilidadSede($hotelId: ID!, $desde: String!, $hasta: String!) {
        disponibilidadHotel(hotelId: $hotelId, desde: $desde, hasta: $hasta) {
          disponible
          motivo
          reservaFolio
          reservaEstado
          recurso {
            id
            nombre
            tipo
            capacidad
            tarifa
            descripcion
            foto
          }
        }
      }
    `;

    const res = await this.graphql(query, { hotelId, desde, hasta });
    if (!container) return;

    if (res.data?.disponibilidadHotel) {
      const items = res.data.disponibilidadHotel;
      if (items.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 30px; color: #64748b;">
            <p>No se encontraron habitaciones registradas para esta sucursal.</p>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <strong style="font-size: 0.88rem; color: #0f172a;">
            Disponibilidad en esta Sede del ${desde} al ${hasta}:
          </strong>
          <span style="font-size: 0.82rem; color: #16a34a; font-weight: 700;">
            ${items.filter(x => x.disponible).length} de ${items.length} Disponibles
          </span>
        </div>
        <div class="hotel-detail-rooms-list" style="display: flex; flex-direction: column; gap: 10px;">
        </div>
      `;
      const listEl = container.querySelector(".hotel-detail-rooms-list");

      items.forEach(item => {
        const r = item.recurso;
        const row = document.createElement("div");
        row.className = "room-avail-item";
        row.style.cssText = `
          display: flex;
          align-items: center;
          gap: 14px;
          background: #ffffff;
          border: 1px solid ${item.disponible ? '#bbf7d0' : '#fecaca'};
          border-left: 4px solid ${item.disponible ? '#16a34a' : '#ef4444'};
          border-radius: var(--radius-sm);
          padding: 10px 14px;
        `;

        const statusBadge = item.disponible
          ? `<span class="badge-status badge-confirmada" style="background:#dcfce7; color:#15803d; font-size:0.75rem;">🟢 DISPONIBLE</span>`
          : `<span class="badge-status badge-cancelada" style="background:#fee2e2; color:#b91c1c; font-size:0.75rem;">🔴 ${item.motivo}</span>`;

        const actionBtn = item.disponible
          ? `<button class="btn btn-primary btn-sm" onclick="app.closeModal('hotelDetailModal'); app.iniciarProcesoReserva('${r.id}')">Reservar</button>`
          : `<span style="font-size: 0.76rem; color: #94a3b8; font-weight: 600;">No disponible</span>`;

        row.innerHTML = `
          <img src="${r.foto}" alt="${r.nombre}" style="width: 70px; height: 55px; border-radius: 6px; object-fit: cover;">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <strong style="color: #0f172a; font-size: 0.92rem;">${r.nombre}</strong>
              ${statusBadge}
            </div>
            <div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">
              Capacidad: ${r.capacidad} personas &bull; Tarifa: $${r.tarifa.toLocaleString('es-MX', { minimumFractionDigits: 2 })} MXN/noche
            </div>
          </div>
          <div>
            ${actionBtn}
          </div>
        `;
        listEl.appendChild(row);
      });
    }
  },

  async cargarRecursos(hotelId = null, tipo = null) {
    const query = `
      query ObtenerRecursos($hotelId: ID, $tipo: String) {
        recursos(hotelId: $hotelId, tipo: $tipo) {
          id
          hotelId
          nombre
          tipo
          capacidad
          tarifa
          descripcion
          foto
        }
      }
    `;

    const variables = {};
    if (hotelId && hotelId !== "TODOS") variables.hotelId = hotelId;
    if (tipo && tipo !== "TODOS") variables.tipo = tipo;

    const res = await this.graphql(query, variables);
    if (res.data?.recursos) {
      this.allRecursos = res.data.recursos;
      this.renderRecursos(this.allRecursos);
    }
  },

  renderRecursos(recursos) {
    const grid = document.getElementById("catalogGrid");
    if (!grid) return;
    grid.innerHTML = "";

    if (recursos.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #64748b;">
          <p style="font-size: 1.1rem;">No se encontraron habitaciones o espacios con los filtros seleccionados.</p>
          <button class="btn btn-secondary btn-sm" style="margin-top: 10px;" onclick="app.resetFilters()">Restablecer Filtros</button>
        </div>
      `;
      return;
    }

    recursos.forEach(r => {
      const card = document.createElement("div");
      card.className = "room-card";

      const hotelObj = this.allHoteles.find(h => h.id === r.hotelId);
      const hotelNombre = hotelObj ? hotelObj.nombre : "Hotel Paraíso";

      let tipoNombre = r.tipo.replace("_", " ");
      if (r.tipo === "HABITACION_LUJO") tipoNombre = "Suite de Lujo";
      if (r.tipo === "HABITACION_DOBLE") tipoNombre = "Habitación Doble";
      if (r.tipo === "RESTAURANTE_MESA") tipoNombre = "Mesa de Restaurante";
      if (r.tipo === "SALON_EVENTOS") tipoNombre = "Salón de Eventos";

      card.innerHTML = `
        <div class="room-card-img-wrap">
          <img src="${r.foto}" alt="${r.nombre}" class="room-card-img" loading="lazy">
          <span class="room-type-tag">${tipoNombre}</span>
          <span class="room-hotel-tag">${hotelNombre}</span>
        </div>
        <div class="room-card-body">
          <h3 class="room-card-title">${r.nombre}</h3>
          <p class="room-card-desc">${r.descripcion}</p>
          
          <div class="room-card-features">
            <span class="room-feature-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              ${r.capacidad} personas
            </span>
            <span class="room-feature-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              Limpieza incluida
            </span>
            <span class="room-feature-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
              Wi-Fi alta velocidad
            </span>
          </div>

          <div class="room-card-footer">
            <div class="room-price-box">
              <span class="room-price">$${r.tarifa.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN</span>
              <small>por noche / reserva</small>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-sm" onclick="app.openReviewsModal('${r.id}', '${r.nombre.replace(/'/g, "\\'")}')" title="Ver y dejar opiniones de la Tienda Online">
                ⭐ Opiniones
              </button>
              <button class="btn btn-primary btn-sm" onclick="app.iniciarProcesoReserva('${r.id}')">
                Reservar
              </button>
            </div>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  },

  filterByHotel(hotelId) {
    this.selectedHotelId = hotelId;
    const select = document.getElementById("searchHotel");
    if (select) select.value = hotelId;

    const desc = document.getElementById("currentHotelFilterDesc");
    if (desc) {
      if (hotelId === "TODOS") {
        desc.textContent = "Mostrando todas las habitaciones de la cadena hotelera:";
      } else {
        const h = this.allHoteles.find(x => x.id === hotelId);
        desc.textContent = `Mostrando habitaciones de: ${h ? h.nombre : hotelId}`;
      }
    }

    this.cargarRecursos(hotelId, null);
    const habSection = document.getElementById("habitaciones");
    if (habSection) habSection.scrollIntoView({ behavior: "smooth" });
  },

  filterCatalogByType(tipo, btnEl) {
    const pills = document.querySelectorAll("#catalogFilterPills .filter-btn");
    pills.forEach(p => p.classList.remove("active"));
    if (btnEl) btnEl.classList.add("active");

    this.cargarRecursos(this.selectedHotelId, tipo);
  },

  resetFilters() {
    this.selectedHotelId = "TODOS";
    const select = document.getElementById("searchHotel");
    if (select) select.value = "TODOS";

    const pills = document.querySelectorAll("#catalogFilterPills .filter-btn");
    pills.forEach(p => p.classList.remove("active"));
    if (pills[0]) pills[0].classList.add("active");

    this.cargarRecursos();
  },

  executeSearch() {
    const hotelId = document.getElementById("searchHotel").value;
    this.filterByHotel(hotelId);
  },

  // Modal para agregar nuevo recurso al catálogo (Solo Administrador)
  openNuevoRecursoModal() {
    if (!this.currentUser || this.currentUser.rol !== "administrador") {
      this.showToast("Solo los administradores pueden agregar recursos al catálogo", "error");
      return;
    }
    this.openModal("catalogNewResourceModal");
  },

  async guardarNuevoRecursoSubmit(e) {
    e.preventDefault();
    const nombre = document.getElementById("nuevoRecNombre").value.trim();
    const hotelId = document.getElementById("nuevoRecHotel").value;
    const tipo = document.getElementById("nuevoRecTipo").value;
    const capacidad = parseInt(document.getElementById("nuevoRecCapacidad").value);
    const tarifa = parseFloat(document.getElementById("nuevoRecTarifa").value);
    const descripcion = document.getElementById("nuevoRecDesc").value.trim();
    const foto = document.getElementById("nuevoRecFoto").value.trim();

    const mutation = `
      mutation CrearRecurso($input: CrearRecursoInput!) {
        crearRecurso(input: $input) {
          id
          nombre
          tarifa
          tipo
        }
      }
    `;

    const res = await this.graphql(mutation, {
      input: { nombre, hotelId, tipo, capacidad, tarifa, descripcion, foto }
    });

    if (res.data?.crearRecurso) {
      this.showToast(`Recurso '${nombre}' agregado al catálogo exitosamente.`, "success");
      this.closeModal("catalogNewResourceModal");
      await this.cargarRecursos(this.selectedHotelId);
      await this.cargarContabilizacion();
    } else {
      const errorMsg = res.errors?.[0]?.message || "Error al crear recurso en el catálogo";
      this.showToast(errorMsg, "error");
    }
  },

  // ==============================================================================
  // 3. MOTOR DE RESERVACIONES (SERVICIO 3: RESERVACIONES)
  // ==============================================================================
  iniciarProcesoReserva(recursoId) {
    if (!this.currentUser) {
      this.pendingRecursoId = recursoId;
      const notice = document.getElementById("authNoticeBooking");
      if (notice) notice.style.display = "block";
      this.openAuthModal("login");
      return;
    }
    this.openBookingModal(recursoId);
  },

  openBookingModal(recursoId) {
    const rec = this.allRecursos.find(r => r.id === recursoId);
    if (!rec) return;

    this.selectedRecurso = rec;
    document.getElementById("modalRecursoId").value = rec.id;
    document.getElementById("bookingPreviewName").textContent = rec.nombre;
    document.getElementById("bookingPreviewRate").textContent = `$${rec.tarifa.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;
    document.getElementById("bookingPreviewImg").src = rec.foto;

    const inEl = document.getElementById("searchCheckIn");
    const outEl = document.getElementById("searchCheckOut");
    if (inEl && inEl.value) document.getElementById("modalFechaInicio").value = inEl.value;
    if (outEl && outEl.value) document.getElementById("modalFechaFin").value = outEl.value;

    const guestInput = document.getElementById("modalPersonas");
    if (guestInput) guestInput.max = rec.capacidad;

    document.getElementById("modalGuestName").textContent = this.currentUser.nombre;
    document.getElementById("modalGuestRole").textContent = this.currentUser.rol;

    this.recalcularCostoModal();
    this.openModal("bookingModal");
  },

  recalcularCostoModal() {
    if (!this.selectedRecurso) return;

    const fIniStr = document.getElementById("modalFechaInicio").value;
    const fFinStr = document.getElementById("modalFechaFin").value;

    if (!fIniStr || !fFinStr) return;

    const dIni = new Date(fIniStr);
    const dFin = new Date(fFinStr);

    let noches = Math.round((dFin - dIni) / (1000 * 60 * 60 * 24));
    if (noches < 1) noches = 1;

    const total = noches * this.selectedRecurso.tarifa;

    document.getElementById("costBreakdownNoches").textContent = `${noches} noche${noches > 1 ? "s" : ""}`;
    document.getElementById("costBreakdownTotal").textContent = `$${total.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;
  },

  async confirmarReservacion(e) {
    e.preventDefault();
    if (!this.currentUser) return;

    const recursoId = document.getElementById("modalRecursoId").value;
    const fechaInicio = document.getElementById("modalFechaInicio").value + "T15:00:00";
    const fechaFin = document.getElementById("modalFechaFin").value + "T12:00:00";
    const personas = parseInt(document.getElementById("modalPersonas").value);

    const mutation = `
      mutation CrearReserva($input: CrearReservacionInput!) {
        crearReservacion(input: $input) {
          id
          folio
          estado
          total
          fechaInicio
          fechaFin
          personas
          recurso {
            nombre
            tarifa
          }
        }
      }
    `;

    const variables = {
      input: {
        usuarioId: this.currentUser.id,
        recursoId: recursoId,
        fechaInicio: fechaInicio,
        fechaFin: fechaFin,
        personas: personas
      }
    };

    const res = await this.graphql(mutation, variables);

    if (res.data?.crearReservacion) {
      const r = res.data.crearReservacion;
      this.closeModal("bookingModal");
      this.showToast(`Reservación registrada con folio ${r.folio}. Estado: PENDIENTE`, "info");

      await this.cargarMisReservaciones();
      await this.cargarNotificacionesCount();
      await this.cargarContabilizacion();

      // Abrir inmediatamente la Pasarela de Pago para liquidar la estancia
      this.openPaymentModal(r.id, r.folio, r.recurso.nombre, r.total, r.creadoEn);
    } else {
      const errorMsg = res.errors?.[0]?.message || "Error al generar la reservación";
      this.showToast(errorMsg, "error");
    }
  },

  async cargarMisReservaciones() {
    if (!this.currentUser) return;

    const query = `
      query {
        misReservaciones {
          id
          folio
          fechaInicio
          fechaFin
          personas
          estado
          total
          creadoEn
          recurso {
            id
            nombre
            tipo
            foto
            tarifa
          }
        }
      }
    `;

    const res = await this.graphql(query);

    const misSec = document.getElementById("mis-reservaciones");
    const container = document.getElementById("misReservasContainer");
    const badge = document.getElementById("reservaCounterBadge");

    if (res.data?.misReservaciones) {
      const reservas = res.data.misReservaciones;
      if (badge) badge.textContent = reservas.length;

      if (misSec) misSec.style.display = "block";
      if (!container) return;

      if (reservas.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 30px; background: #fff; border-radius: var(--radius-md); border: 1px solid var(--border-color); color: #64748b;">
            <p>Aún no tienes reservaciones activas a tu nombre.</p>
          </div>
        `;
        return;
      }

      container.innerHTML = "";
      reservas.forEach(r => {
        const card = document.createElement("div");
        card.className = "reserva-item-card";

        let badgeClass = "badge-confirmada";
        let statusText = "CONFIRMADA";
        let timerWarning = "";
        let actionButtons = "";

        if (r.estado === "PENDIENTE") {
          badgeClass = "badge-pendiente";
          statusText = "PENDIENTE DE PAGO";
          timerWarning = `
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px; background:#fffbeb; border:1px solid #fef08a; padding:6px 10px; border-radius:6px; font-size:0.8rem; color:#92400e;">
              <span>⏳</span>
              <span>Expira en: <strong class="timer-display-live" data-creado="${r.creadoEn}">15:00</strong> min. La habitación se liberará automáticamente si no se liquida.</span>
            </div>
          `;
          actionButtons += `
            <button class="btn btn-success btn-sm" onclick="app.openPaymentModal('${r.id}', '${r.folio}', '${r.recurso.nombre}', ${r.total}, '${r.creadoEn}')">
              Pagar Ahora
            </button>
            <button class="btn btn-danger btn-sm" onclick="app.liberarReservacionExpirada('${r.id}', '${r.folio}')" title="Liberar habitación y cancelar reserva">
              Liberar Habitación
            </button>
          `;
        } else if (r.estado === "CANCELADA") {
          badgeClass = "badge-cancelada";
          statusText = "CANCELADA / LIBERADA";
          actionButtons += `
            <button class="btn btn-secondary btn-sm" onclick="app.eliminarReservacion('${r.id}', '${r.folio}')" title="Eliminar de mi lista y base de datos">
              Eliminar
            </button>
          `;
        } else {
          actionButtons += `
            <button class="btn btn-danger btn-sm" onclick="app.cancelarReservacion('${r.id}', '${r.folio}')">
              Cancelar
            </button>
          `;
        }

        const fIni = r.fechaInicio.split("T")[0];
        const fFin = r.fechaFin.split("T")[0];

        card.innerHTML = `
          <div class="reserva-item-info">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="badge-status ${badgeClass}">${statusText}</span>
              <strong style="font-family: monospace; font-size: 0.95rem; color: #2563eb;">${r.folio}</strong>
            </div>
            <h4 style="font-size: 1.05rem; color: #0f172a; margin-top: 4px;">${r.recurso.nombre}</h4>
            <div style="font-size: 0.82rem; color: #64748b;">
              Del <strong>${fIni}</strong> al <strong>${fFin}</strong> &bull; ${r.personas} personas
            </div>
            <div style="font-size: 0.9rem; font-weight: 700; color: #16a34a; margin-top: 2px;">
              Total: $${r.total.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN
            </div>
            ${timerWarning}
          </div>
          <div class="reserva-item-actions">
            ${actionButtons}
          </div>
        `;
        container.appendChild(card);
      });

      // Si es admin, cargar también la vista global
      if (this.currentUser.rol === "administrador" && this.adminGlobalVisible) {
        this.cargarTodasReservacionesAdmin();
      }
    }
  },

  async cancelarReservacion(id, folio) {
    if (!confirm(`¿Estás seguro de cancelar la reservación con folio ${folio}?\nSi ya fue pagada, el Servicio de Pagos emitirá tu reembolso automáticamente.`)) {
      return;
    }

    const mutation = `
      mutation CancelarReserva($id: ID!) {
        cancelarReservacion(id: $id) {
          id
          folio
          estado
        }
      }
    `;

    const res = await this.graphql(mutation, { id: id });

    if (res.data?.cancelarReservacion) {
      this.showToast(`Reservación ${folio} cancelada exitosamente. Evento publicado al Bus.`, "success");
      await this.cargarMisReservaciones();
      await this.cargarHoteles();
      await this.cargarRecursos();
      await this.cargarNotificacionesCount();
      if (this.currentUser && this.currentUser.rol === "administrador") {
        await this.actualizarPanelAdminCompleto();
      }
      await this.cargarContabilizacion();
    } else {
      const errorMsg = res.errors?.[0]?.message || "Error al cancelar la reservación";
      this.showToast(errorMsg, "error");
    }
  },

  async eliminarReservacion(id, folio) {
    if (!confirm(`¿Estás seguro de ELIMINAR DEFINITIVAMENTE la reservación ${folio} de la base de datos?\nEsta acción liberará el espacio y borrará el registro de MySQL.`)) {
      return;
    }

    const mutation = `
      mutation EliminarReserva($id: ID!) {
        eliminarReservacion(id: $id) {
          exito
          mensaje
          folio
        }
      }
    `;

    const res = await this.graphql(mutation, { id: id });

    if (res.data?.eliminarReservacion?.exito) {
      this.showToast(`Reservación ${folio} eliminada definitivamente de MySQL.`, "success");
      await this.cargarMisReservaciones();
      await this.cargarHoteles();
      await this.cargarRecursos();
      await this.cargarNotificacionesCount();
      if (this.currentUser && this.currentUser.rol === "administrador") {
        await this.actualizarPanelAdminCompleto();
      }
      await this.cargarContabilizacion();
    } else {
      const errorMsg = res.errors?.[0]?.message || res.data?.eliminarReservacion?.mensaje || "Error al eliminar la reservación";
      this.showToast(errorMsg, "error");
    }
  },

  async liberarReservacionExpirada(id, folio) {
    if (!confirm(`¿Deseas liberar inmediatamente la habitación asociada al folio ${folio}?\nLa reservación pendiente quedará anulada y el espacio disponible para reservar.`)) {
      return;
    }

    const mutation = `
      mutation LiberarReserva($id: ID!) {
        liberarReservacionExpirada(id: $id) {
          id
          folio
          estado
        }
      }
    `;

    const res = await this.graphql(mutation, { id });
    if (res.data?.liberarReservacionExpirada) {
      this.showToast(`Habitación liberada exitosamente (Folio ${folio}).`, "success");
      await this.cargarMisReservaciones();
      await this.cargarHoteles();
      await this.cargarRecursos();
      if (this.currentUser && this.currentUser.rol === "administrador") {
        await this.actualizarPanelAdminCompleto();
      }
      await this.cargarContabilizacion();
    } else {
      const errorMsg = res.errors?.[0]?.message || "Error al liberar la reservación";
      this.showToast(errorMsg, "error");
    }
  },

  scrollMisReservaciones(e) {
    e.preventDefault();
    const sec = document.getElementById("mis-reservaciones");
    if (sec) sec.scrollIntoView({ behavior: "smooth" });
  },

  // ==============================================================================
  // 4. PASARELA DE PAGOS (SERVICIO 4: PAGOS BANCARIOS Y DIGITALES)
  // ==============================================================================
  openPaymentModal(reservaId, folio, recursoNombre, monto, creadoEn = null) {
    document.getElementById("payModalReservaId").value = reservaId;
    document.getElementById("payModalMontoVal").value = monto;
    document.getElementById("payModalFolio").textContent = folio;
    document.getElementById("payModalRecurso").textContent = recursoNombre;
    document.getElementById("payModalMonto").textContent = `$${parseFloat(monto).toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;

    this.activePaymentReserva = {
      reservaId,
      folio,
      recursoNombre,
      monto,
      creadoEn: creadoEn || new Date().toISOString()
    };

    // Por defecto seleccionar Tarjeta Débito / Crédito
    this.selectPaymentMethod("TARJETA_CREDITO");
    this.openModal("paymentModal");
  },

  closePaymentModalAndMarkPending() {
    this.closeModal("paymentModal");
    const folio = document.getElementById("payModalFolio")?.textContent || "RES-XXXX";
    this.showToast(
      `Reservación ${folio} guardada en estado PENDIENTE. Tienes 15 minutos para liquidarla en 'Mis Reservaciones' antes de que la habitación sea liberada.`,
      "info"
    );
    this.cargarMisReservaciones();
  },

  iniciarTemporizadorGlobal() {
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);

    this.timerIntervalId = setInterval(() => {
      const ahora = new Date().getTime();

      // 1. Modal de pago abierto
      if (this.activePaymentReserva && this.activePaymentReserva.creadoEn) {
        const creadoMs = new Date(this.activePaymentReserva.creadoEn).getTime();
        const diffSegundos = Math.max(0, (15 * 60) - Math.floor((ahora - creadoMs) / 1000));
        const min = Math.floor(diffSegundos / 60);
        const seg = diffSegundos % 60;
        const timeStr = `${String(min).padStart(2, '0')}:${String(seg).padStart(2, '0')} min`;

        const elTimerModal = document.getElementById("payModalTimerCountdown");
        if (elTimerModal) elTimerModal.textContent = timeStr;

        if (diffSegundos <= 0) {
          this.closeModal("paymentModal");
          this.showToast("Tiempo de espera agotado (15 min). La reservación ha sido liberada.", "warning");
          this.activePaymentReserva = null;
          this.cargarMisReservaciones();
          if (this.currentUser && this.currentUser.rol === "administrador") {
            this.actualizarPanelAdminCompleto();
          }
        }
      }

      // 2. Elementos vivos en Mis Reservaciones y Consola PMS
      document.querySelectorAll(".timer-display-live").forEach(el => {
        const creadoStr = el.getAttribute("data-creado");
        if (!creadoStr) return;
        const creadoMs = new Date(creadoStr).getTime();
        const diffSegundos = Math.max(0, (15 * 60) - Math.floor((ahora - creadoMs) / 1000));
        const min = Math.floor(diffSegundos / 60);
        const seg = diffSegundos % 60;
        el.textContent = `${String(min).padStart(2, '0')}:${String(seg).padStart(2, '0')}`;

        if (diffSegundos <= 0 && !el.getAttribute("data-expired")) {
          el.setAttribute("data-expired", "true");
          const parent = el.closest(".reserva-timer-pill") || el.parentElement;
          if (parent) {
            parent.innerHTML = `<span style="color:#ef4444; font-weight:700;">Expirada y Liberada</span>`;
          }
        }
      });
    }, 1000);
  },

  selectPaymentMethod(metodo) {
    document.getElementById("paySelectedMethod").value = metodo;

    const cards = [
      { id: "payMethodCard_TARJETA", m: "TARJETA_CREDITO" },
      { id: "payMethodCard_SPEI", m: "TRANSFERENCIA" },
      { id: "payMethodCard_PAYPAL", m: "PAYPAL" }
    ];

    cards.forEach(c => {
      const el = document.getElementById(c.id);
      if (el) {
        if (c.m === metodo) el.classList.add("active");
        else el.classList.remove("active");
      }
    });

    const cardFields = document.getElementById("cardDetailsMock");
    if (cardFields) {
      cardFields.style.display = metodo === "TARJETA_CREDITO" ? "block" : "none";
    }

    const speiFields = document.getElementById("speiDetailsMock");
    if (speiFields) {
      speiFields.style.display = metodo === "TRANSFERENCIA" ? "block" : "none";
    }

    const paypalFields = document.getElementById("paypalDetailsMock");
    if (paypalFields) {
      paypalFields.style.display = metodo === "PAYPAL" ? "block" : "none";
    }

    const btnPagar = document.getElementById("btnPagarConfirmar");
    if (btnPagar) {
      btnPagar.textContent = "Pagar y Confirmar Estancia";
    }
  },

  // Procesa el envio del formulario de pago hacia la API de GraphQL
  async procesarPagoSubmit(e) {
    // Evita que el navegador recargue la pagina al enviar el formulario
    e.preventDefault();

    // Obtiene el ID de la reservacion que se va a pagar desde el modal
    const reservacionId = document.getElementById("payModalReservaId").value;
    // Obtiene el metodo de pago seleccionado (TARJETA_CREDITO, TRANSFERENCIA o PAYPAL)
    const metodoPago = document.getElementById("paySelectedMethod").value;
    // Convierte el importe a numero flotante para que coincida con el Float de GraphQL
    const monto = parseFloat(document.getElementById("payModalMontoVal").value);
    // Guarda el folio de la reservacion para imprimirlo en el comprobante
    const folio = document.getElementById("payModalFolio").textContent;

    // Mutacion de GraphQL que ejecuta el cobro con el adaptador SOA de la Tienda de Alan
    const mutation = `
      mutation PagarReserva($input: PagarReservacionInput!) {
        pagarReservacion(input: $input) {
          id
          reservacionId
          monto
          metodoPago
          estado
          comprobante
          fecha
          transactionRef
          orderId
          orderNumber
          receiptNumber
          servicioExterno
          refundToken
        }
      }
    `;

    // Manda la peticion POST a /graphql con las variables y el token JWT
    const res = await this.graphql(mutation, {
      input: {
        reservacionId: reservacionId,
        metodoPago: metodoPago,
        monto: monto,
        tipoPago: "TOTAL"
      }
    });

    // Si el backend respondio con exito el pago aprobado
    if (res.data?.pagarReservacion) {
      const p = res.data.pagarReservacion;
      this.activePaymentReserva = null;
      // Cierra la ventana modal de cobro
      this.closeModal("paymentModal");

      // Llena los datos del comprobante oficial (voucher) con la respuesta de MySQL
      document.getElementById("voucherPagoComprobante").textContent = p.comprobante;
      document.getElementById("voucherPagoFolio").textContent = folio;
      document.getElementById("voucherPagoMonto").textContent = `$${p.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;
      document.getElementById("voucherPagoMetodo").textContent = p.metodoPago.replace("_", " ");

      // Referencias del servicio de Tienda Online (Alan López)
      if (document.getElementById("voucherPagoTxnRef")) {
        document.getElementById("voucherPagoTxnRef").textContent = p.transactionRef || "N/A";
      }
      if (document.getElementById("voucherPagoOrder")) {
        document.getElementById("voucherPagoOrder").textContent = p.orderNumber || p.receiptNumber || "N/A";
      }
      if (document.getElementById("voucherPagoServicio")) {
        document.getElementById("voucherPagoServicio").textContent = p.servicioExterno || "Tienda Online (Alan)";
      }

      // Abre el modal de exito con el comprobante digital
      this.openModal("paymentSuccessModal");
      this.showToast("¡Pago aprobado! Transacción sincronizada con la Tienda Online y confirmada.", "success");

      // Refresca las reservaciones para que ahora aparezca en verde como CONFIRMADA
      await this.cargarMisReservaciones();
      await this.cargarHoteles();
      await this.cargarRecursos();
      // Actualiza la campanita con la nueva notificacion de pago recibida
      await this.cargarNotificacionesCount();
      // Registra el movimiento en la auditoria contable de MySQL
      await this.cargarContabilizacion();
    // Si hubo un error (fondos insuficientes o sesion vencida)
    } else {
      const errorMsg = res.errors?.[0]?.message || "Error al procesar el pago";
      this.showToast(errorMsg, "error");
    }
  },

  // ==============================================================================
  // 5. CENTRO DE NOTIFICACIONES (SERVICIO 5: NOTIFICACIONES)
  // ==============================================================================
  async cargarNotificacionesCount() {
    if (!this.currentUser) return;

    const query = `
      query {
        misNotificaciones {
          id
        }
      }
    `;

    const res = await this.graphql(query);
    if (res.data?.misNotificaciones) {
      const count = res.data.misNotificaciones.length;
      const badge = document.getElementById("notifBadgeCount");
      if (badge) badge.textContent = count;
    }
  },

  async openNotificacionesModal() {
    if (!this.currentUser) {
      this.showToast("Inicia sesión para revisar tus notificaciones", "info");
      this.openAuthModal("login");
      return;
    }

    await this.cargarNotificaciones();
    this.openModal("notificacionesModal");
  },

  // Funcion asincrona para consultar las notificaciones al backend sin trabar la pagina
  async cargarNotificaciones() {
    // Si no hay nadie logueado, se sale para no dar error
    if (!this.currentUser) return;

    // Revisa si el usuario actual es admin o cliente para saber que permisos tiene
    const isAdmin = this.currentUser.rol === "administrador";
    // Agarra el texto del titulo y el boton de limpiar del HTML para modificarlos
    const statusInfo = document.getElementById("notifStatusInfo");
    const btnLimpiar = document.getElementById("btnLimpiarNotificaciones");

    // Le cambia el texto al boton: al admin le da opcion de borrar todo y al cliente solo su bandeja
    if (btnLimpiar) {
      btnLimpiar.textContent = isAdmin ? "🗑️ Limpiar Historial Global" : "🗑️ Limpiar Mi Bandeja";
      btnLimpiar.title = isAdmin ? "Vaciar todas las notificaciones del sistema registradas en MySQL" : "Vaciar tu bandeja de notificaciones";
    }

    // Variables donde guardamos la consulta GraphQL y la clave con la que vendran los datos
    let query = "";
    let dataKey = "";

    // Si es admin, pide historialNotificaciones para traer todos los mensajes de MySQL
    if (isAdmin) {
      query = `
        query {
          historialNotificaciones {
            id
            usuarioId
            canal
            destinatario
            asunto
            mensaje
            eventoOrigen
            fechaEnvio
          }
        }
      `;
      dataKey = "historialNotificaciones";
      if (statusInfo) statusInfo.textContent = "Vista Global de Administrador (Todas las notificaciones registradas en MySQL):";
    // Si es cliente, pide misNotificaciones para traer solo sus mensajes y no ver los de otros
    } else {
      query = `
        query {
          misNotificaciones {
            id
            canal
            destinatario
            asunto
            mensaje
            eventoOrigen
            fechaEnvio
          }
        }
      `;
      dataKey = "misNotificaciones";
      if (statusInfo) statusInfo.textContent = `Bandeja personal de: ${this.currentUser.nombre} (${this.currentUser.correo}):`;
    }

    // Manda la peticion HTTP POST a /graphql enviando el token JWT en las cabeceras
    const res = await this.graphql(query);
    // Guarda la lista de notificaciones que respondio MySQL en la variable local
    this.allNotificacionesList = res.data?.[dataKey] || [];

    // Actualiza el numerito rojo de la campanita con el total de mensajes
    const badge = document.getElementById("notifBadgeCount");
    if (badge) badge.textContent = this.allNotificacionesList.length;

    // Pone el texto de "X mensajes" dentro del modal
    const totalBadge = document.getElementById("notifTotalBadge");
    if (totalBadge) totalBadge.textContent = `${this.allNotificacionesList.length} mensajes`;

    // Dibuja las tarjetas visuales de las notificaciones en el modal
    this.renderNotificacionesCards();
  },

  renderNotificacionesCards() {
    const list = document.getElementById("notificacionesList");
    if (!list) return;
    list.innerHTML = "";

    const notifs = this.allNotificacionesList || [];

    if (notifs.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; padding: 48px 20px; background: #ffffff; border-radius: 12px; border: 1px dashed #cbd5e1; color: #64748b;">
          <div style="font-size: 2.2rem; margin-bottom: 10px;">📭</div>
          <p style="font-size: 0.95rem; font-weight: 600; color: #1e293b; margin-bottom: 4px;">No hay notificaciones pendientes</p>
          <p style="font-size: 0.8rem; margin: 0;">Tu bandeja está al día con los eventos del sistema.</p>
        </div>
      `;
      return;
    }

    notifs.forEach(n => {
      const card = document.createElement("div");

      const evOrigen = (n.eventoOrigen || '').toUpperCase();
      let cardTypeClass = "notif-card-reserva";
      let badgeTypeClass = "badge-pill-reserva";
      let eventIcon = "📅";

      if (evOrigen.includes("PAGO") || (n.asunto || '').toUpperCase().includes("PAGO") || (n.asunto || '').toUpperCase().includes("COMPROBANTE")) {
        cardTypeClass = "notif-card-pago";
        badgeTypeClass = "badge-pill-pago";
        eventIcon = "💳";
      } else if (evOrigen.includes("CANCEL") || evOrigen.includes("REEMBOLSO") || (n.asunto || '').toUpperCase().includes("CANCEL") || (n.asunto || '').toUpperCase().includes("REEMBOLSO")) {
        cardTypeClass = "notif-card-cancel";
        badgeTypeClass = "badge-pill-cancel";
        eventIcon = "🔴";
      }

      card.className = `notif-card ${cardTypeClass}`;

      const fecha = n.fechaEnvio ? n.fechaEnvio.replace("T", " ").substring(0, 19) : "";

      card.innerHTML = `
        <div class="notif-card-top">
          <div class="notif-card-badges">
            <span class="notif-badge-pill ${badgeTypeClass}">${eventIcon} ${n.eventoOrigen || 'Evento'}</span>
            <span class="notif-channel-tag ${n.canal === 'SMS' ? 'tag-sms' : 'tag-email'}">${n.canal === 'SMS' ? '📱 SMS' : '✉️ EMAIL'}</span>
          </div>
          <button class="btn-delete-notif-card" title="Eliminar esta notificación" onclick="app.eliminarNotificacion('${n.id}', event)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              <line x1="10" y1="11" x2="10" y2="17"/>
              <line x1="14" y1="11" x2="14" y2="17"/>
            </svg>
          </button>
        </div>

        <div class="notif-card-title">${n.asunto}</div>
        <div class="notif-card-text">${n.mensaje}</div>

        <div class="notif-card-footer">
          <div class="notif-card-user">
            <span>👤 Destinatario:</span>
            <span>${n.destinatario}</span>
            ${n.usuarioId ? `<code style="font-size:0.72rem; background:#f1f5f9; padding:2px 6px; border-radius:4px;">${n.usuarioId}</code>` : ''}
          </div>
          <div class="notif-card-date">🕒 ${fecha}</div>
        </div>
      `;
      list.appendChild(card);
    });
  },

  async eliminarNotificacion(id, event) {
    if (event) event.stopPropagation();
    if (!confirm("¿Deseas eliminar esta notificación?")) return;

    const mutation = `
      mutation EliminarNotif($id: ID!) {
        eliminarNotificacion(id: $id) {
          exito
          mensaje
        }
      }
    `;

    const res = await this.graphql(mutation, { id: id });
    if (res.data?.eliminarNotificacion?.exito) {
      this.showToast("Notificación eliminada correctamente", "info");
      await this.cargarNotificaciones();
      await this.cargarNotificacionesCount();
      await this.cargarContabilizacion();
    } else {
      const msg = res.errors?.[0]?.message || res.data?.eliminarNotificacion?.mensaje || "Error al eliminar";
      this.showToast(msg, "error");
    }
  },

  async limpiarTodasNotificaciones() {
    const isAdmin = this.currentUser && this.currentUser.rol === "administrador";
    const promptMsg = isAdmin
      ? "¿Estás seguro de vaciar el HISTORIAL COMPLETO de notificaciones de todo el sistema en MySQL?"
      : "¿Estás seguro de que deseas vaciar tu bandeja personal de notificaciones?";

    if (!confirm(promptMsg)) return;

    const mutation = `
      mutation {
        limpiarNotificaciones {
          exito
          mensaje
          eliminadas
        }
      }
    `;

    const res = await this.graphql(mutation);
    if (res.data?.limpiarNotificaciones?.exito) {
      const cant = res.data.limpiarNotificaciones.eliminadas || 0;
      this.showToast(res.data.limpiarNotificaciones.mensaje || `Bandeja limpiada (${cant} notificaciones)`, "success");
      await this.cargarNotificaciones();
      await this.cargarNotificacionesCount();
      await this.cargarContabilizacion();
    } else {
      const msg = res.errors?.[0]?.message || res.data?.limpiarNotificaciones?.mensaje || "Error al limpiar la bandeja";
      this.showToast(msg, "error");
    }
  },

  // ==============================================================================
  // 6. PANEL TRIPLE A Y ARQUITECTURA SOA (PROFESOR OCTAVIO)
  // ==============================================================================
  openTripleAModal() {
    this.actualizarPanelTripleAToken();
    this.cargarContabilizacion();
    this.openModal("tripleAModal");
  },

  switchAaaTab(tabId) {
    const tabs = document.querySelectorAll("#tripleAModal .tab-item");
    tabs.forEach(t => t.classList.remove("active"));

    const clicked = document.querySelector(`#tripleAModal .tab-item[data-tab="${tabId}"]`);
    if (clicked) clicked.classList.add("active");

    const panes = document.querySelectorAll("#tripleAModal .aaa-content-pane");
    panes.forEach(p => p.classList.remove("active"));

    const targetPane = document.getElementById(tabId);
    if (targetPane) targetPane.classList.add("active");

    if (tabId === "tab-aaa-accounting") {
      this.cargarContabilizacion();
    }
  },

  actualizarPanelTripleAToken() {
    const rawBox = document.getElementById("jwtRawText");
    const payloadBox = document.getElementById("jwtPayloadText");

    if (!rawBox || !payloadBox) return;

    if (this.token && this.currentUser) {
      rawBox.textContent = this.token;

      let payloadDecoded = {};
      try {
        const parts = this.token.split(".");
        if (parts.length === 3) {
          payloadDecoded = JSON.parse(atob(parts[1]));
        }
      } catch (e) {
        payloadDecoded = this.currentUser;
      }
      payloadBox.textContent = JSON.stringify(payloadDecoded, null, 2);
    } else {
      rawBox.textContent = "Sin sesión activa (inicia sesión para emitir token JWT)";
      payloadBox.textContent = "{}";
    }
  },

  copyToken() {
    if (!this.token) {
      this.showToast("No hay token activo para copiar", "warning");
      return;
    }
    navigator.clipboard.writeText(this.token);
    this.showToast("Token JWT copiado al portapapeles", "success");
  },

  // Pruebas de Autorización (RBAC) para el profesor Octavio
  async simularCrearRecursoIlegal() {
    // Si no es cliente, loguearse temporalmente como cliente
    if (!this.currentUser || this.currentUser.rol !== "cliente") {
      await this.quickLogin("juan@cliente.com", "123");
    }

    this.showToast("Cliente intentando ejecutar 'crearRecurso' en el Catálogo...", "info");

    const mutation = `
      mutation {
        crearRecurso(input: {
          hotelId: "h-1",
          nombre: "Suite Hackeada",
          tipo: "HABITACION_LUJO",
          capacidad: 4,
          tarifa: 100.0,
          descripcion: "Intento no autorizado",
          foto: "http://foto.com"
        }) {
          id
        }
      }
    `;

    const res = await this.graphql(mutation);
    if (res.errors && res.errors.length > 0) {
      alert(`[CONTROL DE ACCESO RBAC - 403 FORBIDDEN]\nEl API Gateway rechazó la mutación:\n"${res.errors[0].message}"\n\nEl incidente fue auditado en la tabla 'auditoria' de MySQL.`);
      await this.cargarContabilizacion();
    } else {
      this.showToast("Error inesperado en prueba", "error");
    }
  },

  async simularViolacionAutorizacion() {
    if (!this.currentUser || this.currentUser.rol !== "cliente") {
      await this.quickLogin("juan@cliente.com", "123");
    }

    this.showToast("Cliente Juan intentando cancelar la reserva ajena 'res-2' de María...", "info");

    const mutation = `
      mutation {
        cancelarReservacion(id: "res-2") {
          id
        }
      }
    `;

    const res = await this.graphql(mutation);
    if (res.errors && res.errors.length > 0) {
      alert(`[CONTROL DE PROPIEDAD - OWNERSHIP CHECK]\nAcceso denegado:\n"${res.errors[0].message}"\n\nIncidente registrado en la bitácora contable.`);
      await this.cargarContabilizacion();
    } else {
      this.showToast("Error inesperado en prueba", "error");
    }
  },

  async simularLoginFallido() {
    this.showToast("Enviando credenciales inválidas para prueba de auditoría...", "info");
    const query = `
      mutation {
        iniciarSesion(correo: "admin@hotel.com", password: "CLAVE_INCORRECTA_999") {
          exito
          mensaje
        }
      }
    `;
    const res = await this.graphql(query);
    if (res.data?.iniciarSesion?.exito === false) {
      alert(`[AUTENTICACIÓN - CREDENCIALES INVÁLIDAS]\nEl servidor rechazó las credenciales y registró el fallo en la tabla 'auditoria' de MySQL.`);
      await this.cargarContabilizacion();
    }
  },

  async cargarContabilizacion() {
    // Si no hay sesión o no es admin, usamos credenciales de admin para poblar las métricas
    let tokenToUse = this.token;
    if (!this.currentUser || this.currentUser.rol !== "administrador") {
      // Pedimos silenciosamente token de admin para el panel
      const resLogin = await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation { iniciarSesion(correo: "admin@hotel.com", password: "123") { token } }`
        })
      });
      const data = await resLogin.json();
      tokenToUse = data.data?.iniciarSesion?.token || "";
    }

    const query = `
      query {
        reporteContabilizacion {
          id
          timestamp
          usuarioNombre
          servicio
          accion
          estado
          monto
          detalle
        }
        metricasSaas {
          totalTransacciones
          totalReservado
          totalUsuarios
          totalReservacionesActivas
          intentosBloqueados
          totalPagosAprobados
          totalMontoCobrado
          totalNotificacionesEnviadas
        }
      }
    `;

    try {
      const response = await fetch("/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${tokenToUse}`
        },
        body: JSON.stringify({ query })
      });
      const res = await response.json();

      if (res.data?.metricasSaas) {
        const m = res.data.metricasSaas;
        const kpiMonto = document.getElementById("kpiMonto");
        const kpiPagos = document.getElementById("kpiPagosCobrados");
        const kpiNotifs = document.getElementById("kpiNotifs");
        const kpiBloqueados = document.getElementById("kpiBloqueados");
        const adminTotalCobrado = document.getElementById("adminPmsTotalCobrado");

        if (kpiMonto) kpiMonto.textContent = `$${m.totalReservado.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;
        if (kpiPagos) kpiPagos.textContent = `$${m.totalMontoCobrado.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;
        if (adminTotalCobrado) adminTotalCobrado.textContent = `$${m.totalMontoCobrado.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;
        if (kpiNotifs) kpiNotifs.textContent = m.totalNotificacionesEnviadas;
        if (kpiBloqueados) kpiBloqueados.textContent = m.intentosBloqueados;
      }

      if (res.data?.reporteContabilizacion) {
        const logs = res.data.reporteContabilizacion;
        const tbodyModal = document.getElementById("accountingTableBody");
        const tbodyLive = document.getElementById("adminLiveAuditTableBody");

        const renderLogsInTable = (tbody, limit = 30) => {
          if (!tbody) return;
          tbody.innerHTML = "";
          logs.slice(0, limit).forEach(log => {
            const tr = document.createElement("tr");

            let badgeColor = "#16a34a";
            if (log.estado === "DENEGADO") badgeColor = "#dc2626";
            if (log.estado === "FALLIDO") badgeColor = "#d97706";

            const hora = log.timestamp.split("T")[1]?.substring(0, 8) || log.timestamp;

            tr.innerHTML = `
              <td><code>${hora}</code></td>
              <td><strong>${log.servicio}</strong></td>
              <td><code>${log.accion}</code></td>
              <td><span style="color: ${badgeColor}; font-weight: 700;">${log.estado}</span></td>
              <td>${log.usuarioNombre || "-"}</td>
              <td>$${log.monto.toLocaleString("es-MX", { minimumFractionDigits: 2 })}</td>
              <td style="font-size: 0.72rem; color: #475569;">${log.detalle}</td>
            `;
            tbody.appendChild(tr);
          });
        };

        renderLogsInTable(tbodyModal, 30);
        renderLogsInTable(tbodyLive, 15);
      }
    } catch (e) {
      console.warn("No se pudo cargar bitácora contable:", e);
    }
  },

  async cargarTodasReservacionesAdmin() {
    if (!this.currentUser || this.currentUser.rol !== "administrador") return;

    const query = `
      query {
        todasReservaciones {
          id
          folio
          usuarioId
          usuarioNombre
          usuarioCorreo
          fechaInicio
          fechaFin
          estado
          total
          creadoEn
          recurso {
            id
            nombre
            hotelId
          }
        }
      }
    `;

    const res = await this.graphql(query);
    if (res.data?.todasReservaciones) {
      this.adminReservacionesList = res.data.todasReservaciones;

      // Actualizar contadores por estado para las pestañas
      const totalCount = this.adminReservacionesList.length;
      const pendientesCount = this.adminReservacionesList.filter(r => r.estado === "PENDIENTE").length;
      const confirmadasCount = this.adminReservacionesList.filter(r => r.estado === "CONFIRMADA").length;
      const canceladasCount = this.adminReservacionesList.filter(r => r.estado === "CANCELADA").length;

      const bTodas = document.getElementById("adminBadgeTodas");
      const bPend = document.getElementById("adminBadgePendiente");
      const bConf = document.getElementById("adminBadgeConfirmada");
      const bCanc = document.getElementById("adminBadgeCancelada");

      if (bTodas) bTodas.textContent = totalCount;
      if (bPend) bPend.textContent = pendientesCount;
      if (bConf) bConf.textContent = confirmadasCount;
      if (bCanc) bCanc.textContent = canceladasCount;

      this.renderTodasReservacionesAdmin();
    }
  },

  setAdminSucursal(hotelId, btnEl) {
    this.adminSelectedHotelId = hotelId || "TODAS";
    const pills = document.querySelectorAll("#adminSucursalFilterPills .sucursal-pill");
    pills.forEach(p => p.classList.remove("active"));
    if (btnEl) {
      btnEl.classList.add("active");
    } else {
      const target = document.querySelector(`#adminSucursalFilterPills .sucursal-pill[data-hotel="${hotelId}"]`);
      if (target) target.classList.add("active");
    }

    this.calcularMetricasOcupacionHotel();
    this.renderAdminRoomsGrid();
    this.renderTodasReservacionesAdmin();
  },

  filterAdminReservations(status, btnEl) {
    this.adminStatusFilter = status;
    const tabs = document.querySelectorAll("#adminStatusFilters .admin-tab-btn");
    tabs.forEach(t => t.classList.remove("active"));
    if (btnEl) btnEl.classList.add("active");
    this.renderTodasReservacionesAdmin();
  },

  renderTodasReservacionesAdmin() {
    const tbody = document.getElementById("todasReservasTableBody");
    if (!tbody) return;

    tbody.innerHTML = "";
    let filtradas = this.adminReservacionesList || [];

    // Filtro por estado
    if (this.adminStatusFilter !== "TODAS") {
      filtradas = filtradas.filter(r => r.estado === this.adminStatusFilter);
    }

    // Filtro por sucursal
    if (this.adminSelectedHotelId && this.adminSelectedHotelId !== "TODAS") {
      filtradas = filtradas.filter(r => r.recurso?.hotelId === this.adminSelectedHotelId);
    }

    if (filtradas.length === 0) {
      let estadoLabel = this.adminStatusFilter;
      if (this.adminStatusFilter === "PENDIENTE") estadoLabel = "EN PROCESO / PENDIENTES";
      else if (this.adminStatusFilter === "CONFIRMADA") estadoLabel = "CONFIRMADAS";
      else if (this.adminStatusFilter === "CANCELADA") estadoLabel = "CANCELADAS";

      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 28px; color: #64748b;">
            No se encontraron reservaciones en la sucursal seleccionada para categoría: <strong>${estadoLabel}</strong>.
          </td>
        </tr>
      `;
      return;
    }

    filtradas.forEach(r => {
      const tr = document.createElement("tr");
      const fIni = r.fechaInicio.split("T")[0];
      const fFin = r.fechaFin.split("T")[0];

      let btnAccion = "-";
      let statusCol = "";

      if (r.estado === "PENDIENTE") {
        statusCol = `
          <div>
            <span class="badge-status badge-pendiente">⏳ PENDIENTE</span>
            <div style="font-size:0.75rem; color:#b45309; margin-top:3px;">
              Expira: <strong class="timer-display-live" data-creado="${r.creadoEn}">15:00</strong>
            </div>
          </div>
        `;
        btnAccion = `
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <button class="btn btn-warning btn-sm" onclick="app.liberarReservacionExpirada('${r.id}', '${r.folio}')" title="Liberar habitación para otros huéspedes">
              Liberar
            </button>
            <button class="btn btn-danger btn-sm" onclick="app.cancelarReservacion('${r.id}', '${r.folio}')" title="Anular">
              Anular
            </button>
            <button class="btn btn-secondary btn-sm" onclick="app.eliminarReservacion('${r.id}', '${r.folio}')" title="Eliminar definitivamente de MySQL">
              Eliminar
            </button>
          </div>
        `;
      } else if (r.estado === "CONFIRMADA") {
        statusCol = `<span class="badge-status badge-confirmada">CONFIRMADA</span>`;
        btnAccion = `
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <button class="btn btn-danger btn-sm" onclick="app.cancelarReservacion('${r.id}', '${r.folio}')" title="Anular y reembolsar">
              Anular
            </button>
            <button class="btn btn-secondary btn-sm" onclick="app.eliminarReservacion('${r.id}', '${r.folio}')" title="Eliminar definitivamente de MySQL">
              Eliminar
            </button>
          </div>
        `;
      } else {
        statusCol = `<span class="badge-status badge-cancelada">CANCELADA</span>`;
        btnAccion = `
          <button class="btn btn-secondary btn-sm" onclick="app.eliminarReservacion('${r.id}', '${r.folio}')" title="Eliminar permanentemente de MySQL">
            Eliminar
          </button>
        `;
      }

      // Nombre de la sucursal
      const hotelObj = this.allHoteles ? this.allHoteles.find(h => h.id === r.recurso?.hotelId) : null;
      const hotelLabel = hotelObj ? `<small style="display:block; color:#64748b; font-size:0.72rem;">${hotelObj.nombre}</small>` : "";

      tr.innerHTML = `
        <td><strong style="color: #2563eb; font-family: monospace;">${r.folio}</strong></td>
        <td>
          <div style="font-weight: 700; color: #0f172a; font-size: 0.82rem;">${r.usuarioNombre || 'Huésped (' + r.usuarioId + ')'}</div>
          <div style="font-size: 0.72rem; color: #64748b;">${r.usuarioCorreo ? r.usuarioCorreo + ' &bull; ' : ''}<code>${r.usuarioId}</code></div>
        </td>
        <td>
          <strong>${r.recurso?.nombre || 'Espacio'}</strong>
          ${hotelLabel}
        </td>
        <td>${fIni} a ${fFin}</td>
        <td>$${r.total.toLocaleString("es-MX", { minimumFractionDigits: 2 })}</td>
        <td>${statusCol}</td>
        <td>${btnAccion}</td>
      `;
      tbody.appendChild(tr);
    });
  },

  async renderAdminSucursalesOverview() {
    const container = document.getElementById("adminSucursalesOverview");
    if (!container) return;

    const query = `
      query {
        estadisticasHoteles {
          hotelId
          nombre
          ubicacion
          capacidadTotalPersonas
          totalHabitaciones
          habitacionesDisponiblesHoy
          habitacionesOcupadas
          habitacionesPendientes
          tasaOcupacion
          totalIngresos
        }
      }
    `;

    const res = await this.graphql(query);
    if (!res.data?.estadisticasHoteles) return;

    container.innerHTML = "";
    res.data.estadisticasHoteles.forEach(s => {
      const card = document.createElement("div");
      card.className = "branch-card";
      if (this.adminSelectedHotelId === s.hotelId) {
        card.classList.add("active-branch");
      }

      card.innerHTML = `
        <div class="branch-card-header">
          <div>
            <h4 class="branch-card-title">${s.nombre}</h4>
            <div class="branch-card-loc">📍 ${s.ubicacion}</div>
          </div>
          <span class="branch-card-badge">${s.tasaOcupacion}% Ocupación</span>
        </div>

        <div class="branch-stats-grid">
          <div class="branch-stat-item">
            <span class="val">${s.capacidadTotalPersonas}</span>
            <span class="lbl">Capacidad Huéspedes</span>
          </div>
          <div class="branch-stat-item">
            <span class="val">${s.totalHabitaciones}</span>
            <span class="lbl">Habitaciones</span>
          </div>
          <div class="branch-stat-item">
            <span class="val" style="color: #16a34a;">${s.habitacionesDisponiblesHoy}</span>
            <span class="lbl">Libres Hoy</span>
          </div>
          <div class="branch-stat-item">
            <span class="val" style="color: #dc2626;">${s.habitacionesOcupadas + s.habitacionesPendientes}</span>
            <span class="lbl">Ocupadas/Pend.</span>
          </div>
        </div>

        <div style="margin-top: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem;">
          <span style="color: #64748b;">Ingresos Sede: <strong style="color: #16a34a;">$${s.totalIngresos.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</strong></span>
          <button class="btn btn-secondary btn-sm" style="font-size: 0.75rem; padding: 3px 8px;" onclick="app.setAdminSucursal('${s.hotelId}')">
            Filtrar PMS
          </button>
        </div>
      `;
      container.appendChild(card);
    });
  },

  async actualizarPanelAdminCompleto() {
    if (!this.currentUser || this.currentUser.rol !== "administrador") return;

    await this.cargarTodasReservacionesAdmin();

    // Actualizar catálogo si está vacío o para tener datos frescos
    if (!this.allRecursos || this.allRecursos.length === 0) {
      await this.cargarRecursos();
    }

    await this.renderAdminSucursalesOverview();
    this.calcularMetricasOcupacionHotel();
    this.renderAdminRoomsGrid();
    await this.cargarContabilizacion();
  },

  calcularMetricasOcupacionHotel() {
    let recursosList = this.allRecursos || [];
    let reservacionesList = this.adminReservacionesList || [];

    if (this.adminSelectedHotelId && this.adminSelectedHotelId !== "TODAS") {
      recursosList = recursosList.filter(r => r.hotelId === this.adminSelectedHotelId);
      reservacionesList = reservacionesList.filter(r => r.recurso?.hotelId === this.adminSelectedHotelId);
    }

    const totalHabitaciones = recursosList.length;
    const capacidadTotal = recursosList.reduce((acc, r) => acc + (r.capacidad || 0), 0);

    // Contar cuántas habitaciones tienen al menos una reservación activa (CONFIRMADA o PENDIENTE)
    const activeRes = reservacionesList.filter(r => r.estado === "CONFIRMADA" || r.estado === "PENDIENTE");
    const ocupadasRecursosIds = new Set(activeRes.map(r => r.recurso?.id || r.recursoId).filter(Boolean));
    const ocupadasNombres = new Set(activeRes.map(r => r.recurso?.nombre).filter(Boolean));

    const ocupadasCount = Math.min(
      recursosList.filter(r => ocupadasRecursosIds.has(r.id) || ocupadasNombres.has(r.nombre)).length,
      totalHabitaciones
    );
    const disponiblesCount = Math.max(0, totalHabitaciones - ocupadasCount);
    const pctOcupacion = totalHabitaciones > 0 ? Math.round((ocupadasCount / totalHabitaciones) * 100) : 0;

    // Ingresos cobrados (CONFIRMADA) en esta selección
    const ingresosConfirmados = reservacionesList
      .filter(r => r.estado === "CONFIRMADA")
      .reduce((acc, r) => acc + (r.total || 0), 0);

    const elCapacidad = document.getElementById("adminPmsCapacidadTotal");
    const elTotal = document.getElementById("adminPmsTotalHabitaciones");
    const elDisp = document.getElementById("adminPmsDisponiblesCount");
    const elOcup = document.getElementById("adminPmsOcupadasCount");
    const elPct = document.getElementById("adminPmsOcupacionPct");
    const elPctLbl = document.getElementById("adminPmsOcupacionPctLabel");
    const elBar = document.getElementById("adminOccupancyBar");
    const elCobrado = document.getElementById("adminPmsTotalCobrado");

    if (elCapacidad) elCapacidad.textContent = `${capacidadTotal} personas`;
    if (elTotal) elTotal.textContent = totalHabitaciones;
    if (elDisp) elDisp.textContent = disponiblesCount;
    if (elOcup) elOcup.textContent = ocupadasCount;
    if (elPct) elPct.textContent = `${pctOcupacion}%`;
    if (elPctLbl) elPctLbl.textContent = `${pctOcupacion}% Ocupado`;
    if (elBar) elBar.style.width = `${pctOcupacion}%`;

    // Si está filtrado por sucursal, mostrar ingresos de esa sucursal
    if (this.adminSelectedHotelId && this.adminSelectedHotelId !== "TODAS" && elCobrado) {
      elCobrado.textContent = `$${ingresosConfirmados.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`;
    }
  },

  setAdminRoomStateFilter(filter, btnEl) {
    this.adminRoomStateFilter = filter || "TODAS";
    const pills = document.querySelectorAll("#adminRoomStateFilters .room-filter-pill");
    pills.forEach(p => p.classList.remove("active"));
    if (btnEl) btnEl.classList.add("active");
    this.renderAdminRoomsGrid();
  },

  renderAdminRoomsGrid() {
    const grid = document.getElementById("adminRoomsLiveGrid");
    if (!grid || !this.allRecursos) return;

    grid.innerHTML = "";
    const activeRes = (this.adminReservacionesList || []).filter(r => r.estado === "CONFIRMADA" || r.estado === "PENDIENTE");

    let filteredRecursos = this.allRecursos;
    if (this.adminSelectedHotelId && this.adminSelectedHotelId !== "TODAS") {
      filteredRecursos = filteredRecursos.filter(r => r.hotelId === this.adminSelectedHotelId);
    }

    // Contar ocupadas y desocupadas para la sede actual
    let ocupadasCount = 0;
    let desocupadasCount = 0;

    filteredRecursos.forEach(r => {
      const res = activeRes.find(res => (res.recurso?.id === r.id) || (res.recurso?.nombre === r.nombre) || (res.recursoId === r.id));
      if (res) ocupadasCount++;
      else desocupadasCount++;
    });

    const elTotal = document.getElementById("countRoomsTodas");
    const elOcup = document.getElementById("countRoomsOcupadas");
    const elDisp = document.getElementById("countRoomsDesocupadas");
    if (elTotal) elTotal.textContent = filteredRecursos.length;
    if (elOcup) elOcup.textContent = ocupadasCount;
    if (elDisp) elDisp.textContent = desocupadasCount;

    // Filtrar por pestaña de estado seleccionada
    if (this.adminRoomStateFilter === "OCUPADAS") {
      filteredRecursos = filteredRecursos.filter(r => {
        return activeRes.some(res => (res.recurso?.id === r.id) || (res.recurso?.nombre === r.nombre) || (res.recursoId === r.id));
      });
    } else if (this.adminRoomStateFilter === "DESOCUPADAS") {
      filteredRecursos = filteredRecursos.filter(r => {
        return !activeRes.some(res => (res.recurso?.id === r.id) || (res.recurso?.nombre === r.nombre) || (res.recursoId === r.id));
      });
    }

    if (filteredRecursos.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 36px 20px; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 12px; color: #64748b;">
          <div style="font-size: 2rem; margin-bottom: 8px;">🏨</div>
          <p style="font-size: 0.95rem; font-weight: 600; color: #1e293b; margin-bottom: 4px;">No hay habitaciones para mostrar en este filtro</p>
          <p style="font-size: 0.8rem; margin: 0;">Filtro: ${this.adminRoomStateFilter} &bull; Sede: ${this.adminSelectedHotelId}</p>
        </div>
      `;
      return;
    }

    filteredRecursos.forEach(r => {
      const card = document.createElement("div");
      const hotelObj = this.allHoteles.find(h => h.id === r.hotelId);
      const hotelNombre = hotelObj ? hotelObj.nombre : "Hotel Paraíso";

      // Verificar si tiene estancia activa
      const reservaAsociada = activeRes.find(res => (res.recurso?.id === r.id) || (res.recurso?.nombre === r.nombre) || (res.recursoId === r.id));
      const isOcupada = !!reservaAsociada;

      card.className = `admin-room-item ${isOcupada ? 'is-occupied' : 'is-available'}`;
      card.style.cursor = "pointer";
      card.title = "Haz clic para ver las especificaciones de la habitación y huésped";
      card.onclick = () => app.abrirDetalleHabitacionAdmin(r.id);

      let renterHtml = "";
      let statusBadge = "";

      if (isOcupada) {
        const isConfirmada = reservaAsociada.estado === "CONFIRMADA";
        const fIni = reservaAsociada.fechaInicio ? reservaAsociada.fechaInicio.split("T")[0] : "";
        const fFin = reservaAsociada.fechaFin ? reservaAsociada.fechaFin.split("T")[0] : "";
        const nombreHuesped = reservaAsociada.usuarioNombre || `Usuario (${reservaAsociada.usuarioId})`;
        const correoHuesped = reservaAsociada.usuarioCorreo ? `${reservaAsociada.usuarioCorreo}` : `ID: ${reservaAsociada.usuarioId}`;
        const totalMXN = reservaAsociada.total ? `$${reservaAsociada.total.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN` : "";

        if (isConfirmada) {
          statusBadge = `<span class="admin-status-pill status-ocupado" style="background:#fee2e2; color:#b91c1c;"><span class="status-dot status-dot-amber" style="background:#ef4444;"></span> 🔴 OCUPADA</span>`;
        } else {
          statusBadge = `
            <span class="admin-status-pill status-ocupado" style="background:#fef3c7; color:#92400e;">
              ⏳ EN PROCESO (<span class="timer-display-live" data-creado="${reservaAsociada.creadoEn}">15:00</span>)
            </span>
          `;
        }

        renterHtml = `
          <div class="admin-room-renter-box ${isConfirmada ? '' : 'is-pending'}" onclick="event.stopPropagation()">
            <div class="renter-header">
              <span>👤 Huésped que rentó:</span>
              <span style="font-family: monospace; font-size: 0.72rem;">${reservaAsociada.folio}</span>
            </div>
            <div class="renter-info-row">
              <strong>Nombre:</strong> <span>${nombreHuesped}</span>
            </div>
            <div class="renter-info-row">
              <strong>Contacto:</strong> <span style="word-break: break-all;">${correoHuesped}</span>
            </div>
            <div class="renter-info-row">
              <strong>Estancia:</strong> <span>${fIni} al ${fFin}</span>
            </div>
            ${totalMXN ? `<div class="renter-info-row"><strong>Monto:</strong> <span style="color:#16a34a; font-weight:700;">${totalMXN}</span></div>` : ''}
            
            <div style="display: flex; gap: 6px; margin-top: 8px;">
              <button class="btn btn-secondary btn-xs" style="flex: 1; padding: 6px 8px; font-weight: 700;" onclick="event.stopPropagation(); app.abrirDetalleHabitacionAdmin('${r.id}')" title="Ver ficha técnica completa del huésped">
                🔍 Ficha Huésped
              </button>
              <button class="btn btn-danger btn-xs" style="flex: 1.2; padding: 6px 8px; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 4px;" onclick="event.stopPropagation(); app.cancelarReservacion('${reservaAsociada.id}', '${reservaAsociada.folio}')" title="Cancelar estancia como Administrador">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                Cancelar
              </button>
            </div>
          </div>
        `;
      } else {
        statusBadge = `<span class="admin-status-pill status-disponible"><span class="status-dot status-dot-green"></span> 🟢 DESOCUPADA / DISPONIBLE</span>`;
        renterHtml = `
          <div style="margin-top: 10px; padding: 8px 10px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; font-size: 0.76rem; color: #166534; display: flex; justify-content: space-between; align-items: center;" onclick="event.stopPropagation()">
            <span>✨ Lista para reservar</span>
            <button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); app.abrirDetalleHabitacionAdmin('${r.id}')">🔍 Ver Ficha</button>
          </div>
        `;
      }

      card.innerHTML = `
        <img src="${r.foto}" alt="${r.nombre}" class="admin-room-thumb" loading="lazy">
        <div class="admin-room-info">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap;">
            <div class="admin-room-name" title="${r.nombre}">${r.nombre}</div>
            ${statusBadge}
          </div>
          <div class="admin-room-hotel">${hotelNombre} &bull; Capacidad: ${r.capacidad} pers.</div>
          <div class="admin-room-meta">
            <span class="admin-room-price">$${r.tarifa.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN / noche</span>
          </div>
          ${renterHtml}
        </div>
      `;
      grid.appendChild(card);
    });
  },

  abrirDetalleHabitacionAdmin(recursoId) {
    if (!this.allRecursos) return;
    const r = this.allRecursos.find(item => item.id === recursoId);
    if (!r) return;

    const hotelObj = (this.allHoteles || []).find(h => h.id === r.hotelId);
    const hotelNombre = hotelObj ? hotelObj.nombre : "Hotel Paraíso";
    const hotelUbicacion = hotelObj ? hotelObj.ubicacion : "México";

    const activeRes = (this.adminReservacionesList || []).filter(res => res.estado === "CONFIRMADA" || res.estado === "PENDIENTE");
    const reservaAsociada = activeRes.find(res => (res.recurso?.id === r.id) || (res.recurso?.nombre === r.nombre) || (res.recursoId === r.id));

    const modalTitle = document.getElementById("roomModalTitle");
    const modalSub = document.getElementById("roomModalSubtitle");
    const modalBody = document.getElementById("roomModalBody");
    const modalActions = document.getElementById("roomModalActions");

    if (modalTitle) modalTitle.textContent = r.nombre;
    if (modalSub) modalSub.textContent = `${hotelNombre} • 📍 ${hotelUbicacion}`;

    if (reservaAsociada) {
      const isConfirmada = reservaAsociada.estado === "CONFIRMADA";
      const fIni = reservaAsociada.fechaInicio ? reservaAsociada.fechaInicio.split("T")[0] : "N/A";
      const fFin = reservaAsociada.fechaFin ? reservaAsociada.fechaFin.split("T")[0] : "N/A";
      const nombreHuesped = reservaAsociada.usuarioNombre || `Usuario (${reservaAsociada.usuarioId})`;
      const correoHuesped = reservaAsociada.usuarioCorreo || `ID: ${reservaAsociada.usuarioId}`;
      const totalMXN = reservaAsociada.total ? `$${reservaAsociada.total.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN` : "N/A";
      const fechaCreacion = reservaAsociada.creadoEn ? reservaAsociada.creadoEn.replace("T", " ").substring(0, 19) : "N/A";

      modalBody.innerHTML = `
        <div style="margin-bottom: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
            <span style="font-size: 0.88rem; font-weight: 700; color: #1e293b;">Estado Operativo:</span>
            ${isConfirmada ? `
              <span class="admin-status-pill status-ocupado" style="background:#fee2e2; color:#b91c1c; font-size: 0.82rem; padding: 4px 12px; border-radius: 9999px;">
                🔴 OCUPADA / CONFIRMADA
              </span>
            ` : `
              <span class="admin-status-pill status-ocupado" style="background:#fef3c7; color:#92400e; font-size: 0.82rem; padding: 4px 12px; border-radius: 9999px;">
                ⏳ EN PROCESO DE PAGO
              </span>
            `}
          </div>

          <!-- ESPECIFICACIONES DEL HUÉSPED QUE RENTÓ -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 14px;">
            <div style="font-size: 0.88rem; font-weight: 700; color: #0f172a; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
              👤 <span>Especificaciones del Huésped que Rentó</span>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 0.82rem;">
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Nombre Completo:</span>
                <strong style="color: #0f172a; font-size: 0.92rem;">${nombreHuesped}</strong>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Correo Electrónico:</span>
                <strong style="color: #2563eb; font-size: 0.88rem;">${correoHuesped}</strong>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">ID de Usuario (Cuenta MySQL):</span>
                <code style="background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 0.76rem;">${reservaAsociada.usuarioId}</code>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Folio Único de Reservación:</span>
                <strong style="color: #059669; font-family: monospace; font-size: 0.9rem;">${reservaAsociada.folio}</strong>
              </div>
            </div>
          </div>

          <!-- DETALLES DE LA ESTANCIA Y TRANSACCIÓN -->
          <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 10px;">
            <div style="font-size: 0.88rem; font-weight: 700; color: #0f172a; margin-bottom: 10px;">
              📅 Fechas de Estancia y Montos
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 0.82rem;">
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Entrada (Check-in):</span>
                <strong>${fIni}</strong>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Salida (Check-out):</span>
                <strong>${fFin}</strong>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Capacidad / Aforo:</span>
                <span>${r.capacidad} Huéspedes</span>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Importe Total:</span>
                <strong style="color: #16a34a; font-size: 0.95rem;">${totalMXN}</strong>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Estado de Pago:</span>
                <span>${isConfirmada ? '✅ Pagado y Liquidado en MySQL' : '⏳ Esperando pago en pasarela'}</span>
              </div>
              <div>
                <span style="color: #64748b; display: block; font-size: 0.74rem;">Fecha de Registro:</span>
                <span style="font-size: 0.76rem; color: #64748b;">${fechaCreacion}</span>
              </div>
            </div>
          </div>
        </div>
      `;

      modalActions.innerHTML = `
        <button class="btn btn-secondary" onclick="app.closeModal('roomDetailAdminModal')">
          Cerrar
        </button>
        <button class="btn btn-danger" style="display: flex; align-items: center; gap: 6px; font-weight: 700;" onclick="app.cancelarDesdeModalHabitacion('${reservaAsociada.id}', '${reservaAsociada.folio}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
          🚫 Cancelar Reservación y Liberar Habitación
        </button>
      `;
    } else {
      modalBody.innerHTML = `
        <div style="text-align: center; padding: 24px 10px;">
          <div style="display: inline-block; padding: 10px 18px; background: #ecfdf5; border-radius: 9999px; margin-bottom: 14px;">
            <span style="color: #059669; font-size: 1.05rem; font-weight: 700;">🟢 Habitación Desocupada y Libre</span>
          </div>
          <p style="font-size: 0.88rem; color: #475569; max-width: 420px; margin: 0 auto 16px;">
            Esta habitación no tiene ninguna reservación activa en este momento. Está 100% disponible en el catálogo de trivago para nuevos huéspedes.
          </p>

          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; max-width: 440px; margin: 0 auto; text-align: left; font-size: 0.82rem;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <div>
                <span style="color: #64748b; font-size: 0.74rem;">Tarifa por noche:</span>
                <div style="font-weight: 700; color: #16a34a; font-size: 0.95rem;">$${r.tarifa.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN</div>
              </div>
              <div>
                <span style="color: #64748b; font-size: 0.74rem;">Capacidad máxima:</span>
                <div style="font-weight: 700; color: #0f172a;">${r.capacidad} personas</div>
              </div>
              <div>
                <span style="color: #64748b; font-size: 0.74rem;">Sede hotelera:</span>
                <div style="font-weight: 600; color: #334155;">${hotelNombre}</div>
              </div>
              <div>
                <span style="color: #64748b; font-size: 0.74rem;">Disponibilidad:</span>
                <div style="font-weight: 700; color: #059669;">Inmediata</div>
              </div>
            </div>
          </div>
        </div>
      `;

      modalActions.innerHTML = `
        <div></div>
        <button class="btn btn-secondary" onclick="app.closeModal('roomDetailAdminModal')">
          Cerrar
        </button>
      `;
    }

    this.openModal("roomDetailAdminModal");
  },

  async cancelarDesdeModalHabitacion(id, folio) {
    this.closeModal("roomDetailAdminModal");
    await this.cancelarReservacion(id, folio);
  },

  toggleAdminGlobalView() {
    const sec = document.getElementById("adminGlobalReservationsSection");
    if (!sec) return;
    this.adminGlobalVisible = !this.adminGlobalVisible;
    sec.style.display = this.adminGlobalVisible ? "block" : "none";
    if (this.adminGlobalVisible) {
      this.actualizarPanelAdminCompleto();
    }
  },

  // ==============================================================================
  // UTILIDADES GENERALES DE LA INTERFAZ
  // ==============================================================================
  openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add("active");
  },

  closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove("active");
  },

  closeModalOutside(e, modalId) {
    if (e.target && e.target.id === modalId) {
      this.closeModal(modalId);
    }
  },

  openAuthModal(tab = "login") {
    this.switchAuthTab(tab);
    this.openModal("authModal");
  },

  switchAuthTab(tab) {
    const btnLogin = document.getElementById("tabBtnLogin");
    const btnReg = document.getElementById("tabBtnRegister");
    const paneLogin = document.getElementById("authPaneLogin");
    const paneReg = document.getElementById("authPaneRegister");

    if (tab === "login") {
      btnLogin.classList.add("active");
      btnReg.classList.remove("active");
      paneLogin.style.display = "block";
      paneReg.style.display = "none";
    } else {
      btnLogin.classList.remove("active");
      btnReg.classList.add("active");
      paneLogin.style.display = "none";
      paneReg.style.display = "block";
    }
  },

  showToast(mensaje, tipo = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${tipo}`;
    toast.textContent = mensaje;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  // ==============================================================================
  // 6. PUENTE SOA: INTEGRACIÓN CON TIENDA ONLINE (ALAN LÓPEZ)
  // ==============================================================================
  async cargarEstadoPuente() {
    try {
      const resp = await fetch("/api/tienda/estado");
      const data = await resp.json();

      const dot = document.getElementById("bridgeStatusDot");
      const text = document.getElementById("bridgeStatusText");
      const badge = document.getElementById("bridgeModalStatusBadge");
      const desc = document.getElementById("bridgeModalStatusDesc");
      const input = document.getElementById("inputNgrokUrl");

      if (input && data.url) {
        input.value = data.url;
      }

      if (data.online) {
        if (dot) dot.className = "bridge-status-dot online";
        if (text) text.textContent = "Tienda Online (En Vivo)";
        if (badge) {
          badge.className = "badge-status badge-confirmada";
          badge.textContent = "🟢 Conectado en Vivo";
        }
        if (desc) desc.textContent = `Microservicio de Alan respondiendo en vivo (${data.latencia_ms} ms).`;
      } else {
        if (dot) dot.className = "bridge-status-dot hybrid";
        if (text) text.textContent = "Tienda Online (Puente Resiliente)";
        if (badge) {
          badge.className = "badge-status badge-pendiente";
          badge.textContent = data.estado === "BLOQUEADO_FORTINET" ? "🛡️ Firewall Escolar (Modo Resiliente)" : "🟡 Modo Respaldo SOA";
        }
        if (desc) desc.textContent = data.mensaje || "Túnel offline o bloqueado por la red. El puente opera con emulación conforme al contrato de Alan.";
      }
    } catch (e) {
      console.warn("No se pudo consultar el estado del puente SOA:", e);
    }
  },

  openBridgeModal() {
    this.openModal("bridgeModal");
    this.cargarEstadoPuente();
  },

  async guardarUrlTienda() {
    const input = document.getElementById("inputNgrokUrl");
    if (!input || !input.value.trim()) {
      this.showToast("Ingresa una URL válida de Ngrok", "warning");
      return;
    }

    try {
      const resp = await fetch("/api/tienda/configuracion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ngrok_url: input.value.trim() })
      });
      const data = await resp.json();
      if (data.exito) {
        this.showToast("URL de Ngrok actualizada con éxito", "success");
        await this.cargarEstadoPuente();
      } else {
        this.showToast(data.mensaje || "Error al actualizar URL", "error");
      }
    } catch (e) {
      this.showToast("Error de comunicación: " + e.message, "error");
    }
  },

  async probarCobroTienda() {
    const logBox = document.getElementById("bridgeConsoleLog");
    if (logBox) logBox.textContent = "// Enviando cobro de prueba POST /api/payments/charge a Alan...\n";

    try {
      const resp = await fetch("/api/tienda/test-cobro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: this.currentUser ? this.currentUser.id : "cliente-101",
          reservation_id: "RES-TEST-2026",
          concept: "Cobro de Prueba Integración SOA",
          amount: 1500.0,
          payment_type: "TOTAL",
          payment_method: "CREDIT_CARD",
          recipient_email: this.currentUser ? this.currentUser.correo : "cliente@correo.com"
        })
      });
      const data = await resp.json();
      if (logBox) {
        logBox.textContent = JSON.stringify(data, null, 2);
      }
      this.showToast("Cobro de prueba procesado (Ref: " + (data.transaction_ref || data.order_number) + ")", "success");
    } catch (e) {
      if (logBox) logBox.textContent = "Error: " + e.message;
      this.showToast("Error en prueba de cobro", "error");
    }
  },

  async probarNotifTienda() {
    const logBox = document.getElementById("bridgeConsoleLog");
    if (logBox) logBox.textContent = "// Despachando email de prueba POST /api/interactions/notifications/email...\n";

    try {
      const resp = await fetch("/api/tienda/test-notificacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: this.currentUser ? this.currentUser.id : "cliente-101",
          recipient_email: this.currentUser ? this.currentUser.correo : "cliente@correo.com",
          type: "RESERVATION_CONFIRMATION",
          reservation_id: "RES-TEST-2026",
          total: 1500.0,
          subject: "¡Prueba de Notificación SOA Exitosa!",
          message: "Este es un mensaje de prueba emitido mediante el adaptador SOA."
        })
      });
      const data = await resp.json();
      if (logBox) {
        logBox.textContent = JSON.stringify(data, null, 2);
      }
      this.showToast("Email de prueba emitido exitosamente", "success");
    } catch (e) {
      if (logBox) logBox.textContent = "Error: " + e.message;
      this.showToast("Error en prueba de notificación", "error");
    }
  },

  // ==============================================================================
  // 7. MICROSERVICIO DE RESEÑAS Y VALORACIONES (TIENDA ONLINE ALAN LÓPEZ)
  // ==============================================================================
  pendingReviewImages: [],

  async openReviewsModal(recursoId, recursoNombre = "") {
    const rIdInput = document.getElementById("reviewRecursoId");
    if (rIdInput) rIdInput.value = recursoId;

    const modalTitle = document.getElementById("reviewsModalTitle");
    if (modalTitle) {
      modalTitle.textContent = recursoNombre ? `Opiniones: ${recursoNombre}` : "Opiniones de Huéspedes";
    }

    this.pendingReviewImages = [];
    this.renderReviewImagesPreview();
    const fileInp = document.getElementById("reviewImagesInput");
    if (fileInp) fileInp.value = "";
    const urlInp = document.getElementById("reviewImageUrlInput");
    if (urlInp) urlInp.value = "";

    this.setReviewRating(5);
    this.openModal("reviewsModal");
    await this.cargarResenasRecurso(recursoId);
  },

  async resizeImage(file, maxDim = 800, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => resolve(e.target.result);
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  async handleReviewImagesUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    if (!this.pendingReviewImages) this.pendingReviewImages = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith("image/")) continue;
      try {
        const base64 = await this.resizeImage(file, 800, 0.75);
        this.pendingReviewImages.push(base64);
      } catch (err) {
        console.error("Error optimizando imagen:", err);
      }
    }
    event.target.value = "";
    this.renderReviewImagesPreview();
  },

  addReviewImageUrl() {
    const input = document.getElementById("reviewImageUrlInput");
    if (!input) return;
    const url = input.value.trim();
    if (!url) {
      this.showToast("Ingresa una URL válida de imagen.", "warning");
      return;
    }
    if (!this.pendingReviewImages) this.pendingReviewImages = [];
    this.pendingReviewImages.push(url);
    input.value = "";
    this.renderReviewImagesPreview();
  },

  removeReviewImage(index) {
    if (this.pendingReviewImages && this.pendingReviewImages.length > index) {
      this.pendingReviewImages.splice(index, 1);
      this.renderReviewImagesPreview();
    }
  },

  renderReviewImagesPreview() {
    const container = document.getElementById("reviewImagesPreview");
    if (!container) return;
    if (!this.pendingReviewImages || this.pendingReviewImages.length === 0) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = this.pendingReviewImages.map((src, idx) => `
      <div style="position: relative; display: inline-block; width: 68px; height: 68px; border-radius: 6px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <img src="${src}" style="width: 100%; height: 100%; object-fit: cover;" alt="Foto previa">
        <button type="button" onclick="app.removeReviewImage(${idx})" style="position: absolute; top: 2px; right: 2px; background: rgba(239, 68, 68, 0.9); color: white; border: none; border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 11px; cursor: pointer; padding: 0; line-height: 1;" title="Quitar foto">✕</button>
      </div>
    `).join("");
  },

  viewFullImage(src) {
    const img = document.getElementById("fullImageViewerImg");
    if (img) img.src = src;
    this.openModal("imageViewerModal");
  },

  setReviewRating(calif) {
    const inputVal = document.getElementById("reviewRatingVal");
    if (inputVal) inputVal.value = calif;

    const stars = document.querySelectorAll("#starRatingPicker .star-item");
    stars.forEach(s => {
      const val = parseInt(s.getAttribute("data-val") || "1");
      if (val <= calif) {
        s.classList.add("active");
      } else {
        s.classList.remove("active");
      }
    });

    const label = document.getElementById("starRatingLabel");
    if (label) {
      const textos = {
        1: "1 de 5 estrellas (Deficiente)",
        2: "2 de 5 estrellas (Regular)",
        3: "3 de 5 estrellas (Bueno)",
        4: "4 de 5 estrellas (Muy bueno)",
        5: "5 de 5 estrellas (Excelente)"
      };
      label.textContent = textos[calif] || `${calif} estrellas`;
    }
  },

  async cargarResenasRecurso(recursoId) {
    const container = document.getElementById("reviewsListContainer");
    if (container) {
      container.innerHTML = "<p style='color: #64748b; font-size: 0.85rem;'>Cargando opiniones...</p>";
    }

    const query = `
      query ObtenerResumenResenas($recursoId: ID!) {
        resumenResenas(recursoId: $recursoId) {
          recursoId
          promedio
          total
          resenas {
            id
            calificacion
            titulo
            comentario
            fecha
            usuarioNombre
            servicioExterno
            reviewIdExterno
            imagenes
          }
        }
      }
    `;

    const res = await this.graphql(query, { recursoId: recursoId });
    if (res.data?.resumenResenas) {
      const summary = res.data.resumenResenas;
      
      const avgScore = document.getElementById("reviewsAverageScore");
      const totalLabel = document.getElementById("reviewsTotalLabel");
      const starsDisplay = document.getElementById("reviewsStarsDisplay");

      if (avgScore) avgScore.textContent = summary.promedio.toFixed(1);
      if (totalLabel) totalLabel.textContent = `${summary.total} ${summary.total === 1 ? "opinión" : "opiniones"}`;
      if (starsDisplay) {
        const fullStars = Math.round(summary.promedio);
        starsDisplay.textContent = "★".repeat(fullStars) + "☆".repeat(5 - fullStars);
      }

      if (container) {
        if (!summary.resenas || summary.resenas.length === 0) {
          container.innerHTML = `
            <div style="text-align: center; padding: 24px; color: #64748b; background: #ffffff; border-radius: 8px; border: 1px dashed #cbd5e1;">
              <p style="margin: 0; font-size: 0.9rem;">Sé el primero en dejar tu opinión sobre esta habitación.</p>
            </div>
          `;
          return;
        }

        container.innerHTML = summary.resenas.map(r => {
          const starsText = "★".repeat(r.calificacion) + "☆".repeat(5 - r.calificacion);
          const fechaStr = r.fecha ? new Date(r.fecha).toLocaleDateString("es-MX", { year: "numeric", month: "short", day: "numeric" }) : "";
          
          const fotosGallery = (r.imagenes && r.imagenes.length > 0) ? `
            <div class="review-gallery" style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; margin-bottom: 8px;">
              ${r.imagenes.map(imgSrc => `
                <img src="${imgSrc}" alt="Foto de huésped" style="width: 76px; height: 76px; object-fit: cover; border-radius: 6px; border: 1px solid #cbd5e1; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;" onmouseover="this.style.transform='scale(1.06)'; this.style.boxShadow='0 4px 10px rgba(0,0,0,0.18)';" onmouseout="this.style.transform='scale(1)'; this.style.boxShadow='none';" onclick="app.viewFullImage('${imgSrc}')" title="Haz clic para ver la foto en tamaño completo">
              `).join("")}
            </div>
          ` : "";

          return `
            <div class="review-card-item" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div>
                  <strong style="color: #0f172a; font-size: 0.92rem;">${r.usuarioNombre}</strong>
                  <span style="color: #f59e0b; margin-left: 8px; letter-spacing: 2px;">${starsText}</span>
                </div>
                <small style="color: #64748b;">${fechaStr}</small>
              </div>
              <h5 style="margin: 4px 0 6px 0; font-size: 0.95rem; color: #1e293b;">${r.titulo}</h5>
              <p style="margin: 0 0 6px 0; font-size: 0.85rem; color: #475569; line-height: 1.4;">${r.comentario}</p>
              ${fotosGallery}
              <div style="display: flex; justify-content: flex-start; margin-top: 4px;">
                <span class="badge-status badge-confirmada" style="font-size: 0.7rem; padding: 2px 6px;">
                  ✓ Verificado vía ${r.servicioExterno || "Tienda Online Alan"}
                </span>
              </div>
            </div>
          `;
        }).join("");
      }
    }
  },

  async submitReview(event) {
    event.preventDefault();

    if (!this.currentUser) {
      this.showToast("Debes iniciar sesión para publicar una reseña.", "warning");
      this.openAuthModal("login");
      return;
    }

    const recursoId = document.getElementById("reviewRecursoId").value;
    const rating = parseInt(document.getElementById("reviewRatingVal").value || "5");
    const titulo = document.getElementById("reviewTitle").value.trim();
    const comentario = document.getElementById("reviewComment").value.trim();

    if (!titulo || !comentario) {
      this.showToast("Por favor completa el título y el comentario.", "warning");
      return;
    }

    const btn = document.getElementById("btnPublicarResena");
    if (btn) btn.disabled = true;

    const mutation = `
      mutation CrearResena($input: CrearResenaInput!) {
        crearResena(input: $input) {
          id
          recursoId
          calificacion
          titulo
          comentario
          fecha
          usuarioNombre
          servicioExterno
          imagenes
        }
      }
    `;

    const fotosAEnviar = (this.pendingReviewImages && this.pendingReviewImages.length > 0) ? this.pendingReviewImages : null;

    const res = await this.graphql(mutation, {
      input: {
        recursoId: recursoId,
        calificacion: rating,
        titulo: titulo,
        comentario: comentario,
        imagenes: fotosAEnviar
      }
    });

    if (btn) btn.disabled = false;

    if (res.data?.crearResena) {
      this.showToast("¡Reseña publicada con éxito en la Tienda Online!", "success");
      document.getElementById("reviewTitle").value = "";
      document.getElementById("reviewComment").value = "";
      this.pendingReviewImages = [];
      this.renderReviewImagesPreview();
      const fileInp = document.getElementById("reviewImagesInput");
      if (fileInp) fileInp.value = "";
      const urlInp = document.getElementById("reviewImageUrlInput");
      if (urlInp) urlInp.value = "";

      await this.cargarResenasRecurso(recursoId);
      await this.cargarContabilizacion();
    } else {
      const err = res.errors?.[0]?.message || "Error al publicar la reseña";
      this.showToast(err, "error");
    }
  }
};

// Autoarranque al cargar la página en el navegador
document.addEventListener("DOMContentLoaded", () => {
  app.init();
});
