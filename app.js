// ==== VERSION ====
const APP_VERSION = "2026-02-20 16:00";
// =================
console.log("✅ App version:", APP_VERSION);

function showFatalError(message) {
  let box = document.getElementById("fatalError");
  if (!box) {
    box = document.createElement("div");
    box.id = "fatalError";
    box.style.position = "fixed";
    box.style.left = "12px";
    box.style.right = "12px";
    box.style.bottom = "12px";
    box.style.zIndex = "9999";
    box.style.padding = "12px 14px";
    box.style.borderRadius = "10px";
    box.style.background = "rgba(180, 0, 0, 0.92)";
    box.style.color = "white";
    box.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    box.style.whiteSpace = "pre-wrap";
    box.style.boxShadow = "0 10px 24px rgba(0,0,0,.25)";

    const btn = document.createElement("button");
    btn.textContent = "Cerrar";
    btn.style.marginLeft = "12px";
    btn.style.padding = "6px 10px";
    btn.style.borderRadius = "8px";
    btn.style.border = "0";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => box.remove());

    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "10px";
    wrap.style.alignItems = "flex-start";

    const txt = document.createElement("div");
    txt.id = "fatalErrorText";
    txt.style.flex = "1";

    wrap.appendChild(txt);
    wrap.appendChild(btn);
    box.appendChild(wrap);
    document.body.appendChild(box);
  }
  const txt = document.getElementById("fatalErrorText");
  if (txt) txt.textContent = message;
}
// app.js — versión completa con:
// - Multi-selección de secciones (checkboxes)
// - Filtro: todas/visitadas/no visitadas
// - Pins + popup (visitada + ratings 0–10) persistente en localStorage
// - Boceto si existe sketch_url
// - Ubicación (watchPosition)
// - Inicio manual (clic en mapa)
// - Ruta optimizada + límite por tiempo/velocidad
// - Checkbox “Ignorar visitadas” en ruta
// - Toggle panel de ruta (si existe)



const VALENCIA = [39.4699, -0.3763];

let map, layerGroup;
let allFallas = [];
let markers = []; // [{ marker, falla_number, section }]

// ------------------ Persistencia ------------------
const STORAGE_KEY = "fallas_state_v1";

function keyForFallaNumber(num) {
  return `falla_${num}`;
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ------------------ Utilidades ------------------
function normalize(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// Haversine (metros)
function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ------------------ Mapa ------------------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView(VALENCIA, 13);

  // Si el usuario toca/arrastra el mapa, dejamos de auto-centrar
  map.on("dragstart zoomstart", () => {
    autoFollowUser = false;
    // evita que justo después de arrastrar vuelva a centrar por el timer
    lastAutoCenterAt = Date.now();
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  layerGroup = (L.markerClusterGroup
    ? L.markerClusterGroup({
        chunkedLoading: true,
        removeOutsideVisibleBounds: true,
        showCoverageOnHover: false,
      })
    : L.layerGroup()
  ).addTo(map);
}

// ------------------ Icono por sección (requiere CSS) ------------------
function normalizeSection(section) {
  if (!section) return "X";
  const s = section.toString().toLowerCase();
  if (s.includes("especial")) return "E";
  if (s.includes("fuera") && s.includes("concurso"))return "FC";
  // Ej: "1ªA" -> "1A"
  return section.replace("ª", "").trim();
}

function createFallaIcon(section, visited) {
  const sec = normalizeSection(section);
  const className = `falla-marker sec-${sec} ${visited ? "falla-visited" : ""}`;

  return L.divIcon({
    html: `<div class="${className}">${sec}</div>`,
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -16],
  });
}

// ------------------ Geolocalización (estable) ------------------
let userMarker = null;
let watchId = null;

// ✅ Control de auto-centrado (para que el mapa no “secuestré” al usuario)
let autoFollowUser = true;              // si el usuario mueve el mapa, lo apagamos
let didInitialCenter = false;           // centrar solo la primera vez
let lastAutoCenterAt = 0;
const AUTO_CENTER_EVERY_MS = 120000;    // <-- cambia X aquí (ms). Ej: 60000=1min, 120000=2min

function locateUser() {
  if (!navigator.geolocation) {
    alert("Tu navegador no permite geolocalización.");
    return;
  }

  // ya siguiendo: centra
  if (watchId !== null) {
    if (userMarker) {
      const ll = userMarker.getLatLng();
      map.setView([ll.lat, ll.lng], 16);
    }
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const ll = [lat, lng];

      // 1) Siempre actualiza el marcador (esto NO mueve el mapa)
      if (!userMarker) {
        userMarker = L.circleMarker(ll, {
          radius: 8,
          color: "#fff",
          weight: 2,
          fillColor: "#007aff",
          fillOpacity: 1,
        }).addTo(map);
      } else {
        userMarker.setLatLng(ll);
      }

      // 2) Centrar solo la primera vez (al activar ubicación)
      if (!didInitialCenter) {
        map.setView(ll, 16);
        didInitialCenter = true;
        lastAutoCenterAt = Date.now();
        return;
      }

      // 3) Auto-centrar como máximo cada X tiempo y solo si seguimos en modo “follow”
      const now = Date.now();
      if (autoFollowUser && now - lastAutoCenterAt >= AUTO_CENTER_EVERY_MS) {
        map.panTo(ll, { animate: true });
        lastAutoCenterAt = now;
      }
    },
    (err) => {
      console.error(err);
      watchId = null;

      const code = err?.code;
      let msg = "No se pudo obtener tu ubicación.";
      if (code === 1) msg = "Permiso denegado. Activa Ubicación para este sitio.";
      if (code === 2) msg = "Posición no disponible (GPS/Wi-Fi).";
      if (code === 3) msg = "Tiempo de espera agotado. Prueba otra vez.";
      alert(msg);
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
  );
}

// ------------------ Inicio manual ------------------
let startMarker = null;
let pickStartMode = false;

function enablePickStartMode() {
  pickStartMode = true;
  alert("Toca el mapa donde quieras poner el inicio de la ruta.");
}

function setStartPoint(lat, lng) {
  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker([lat, lng]).addTo(map).bindPopup("🎯 Inicio de ruta").openPopup();
  pickStartMode = false;

  const btn = document.getElementById("pickStartBtn");
  if (btn) btn.textContent = "🎯 Inicio fijo ✅";
}

function getOrigin() {
  if (startMarker) {
    const ll = startMarker.getLatLng();
    return { lat: ll.lat, lng: ll.lng, label: "🎯 Manual" };
  }
  if (userMarker) {
    const ll = userMarker.getLatLng();
    return { lat: ll.lat, lng: ll.lng, label: "📍 GPS" };
  }
  return null;
}

// ------------------ Multi-secciones (checkboxes) ------------------
function buildSectionFilter(fallas) {
  const listEl = document.getElementById("sectionsList");
  const allCb = document.getElementById("sec_all");
  const btn = document.getElementById("sectionsToggleBtn");
  const panel = document.getElementById("sectionsPanel");

  if (!listEl || !allCb || !btn || !panel) return;

  const sections = Array.from(new Set(fallas.map((f) => f.section)))
    .filter(Boolean)
    .sort();

  listEl.innerHTML = "";

  for (const sec of sections) {
    const row = document.createElement("label");
    row.className = "sec-item";
    row.innerHTML = `
      <input type="checkbox" class="sec-cb" data-section="${sec}" checked />
      <span>${sec}</span>
    `;
    listEl.appendChild(row);
  }

  // Toggle del panel de secciones
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
  });

  // cerrar al clicar fuera
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && e.target !== btn) panel.classList.add("hidden");
  });

  // Todas
  allCb.checked = true;
  allCb.addEventListener("change", () => {
    const checked = allCb.checked;
    document.querySelectorAll(".sec-cb").forEach((cb) => (cb.checked = checked));
    updateSectionsButtonText();
    applyFilters();
  });

  // Cambio en cualquier sección
  listEl.addEventListener("change", (e) => {
    if (!e.target.classList.contains("sec-cb")) return;

    const cbs = Array.from(document.querySelectorAll(".sec-cb"));
    const allChecked = cbs.every((cb) => cb.checked);
    const noneChecked = cbs.every((cb) => !cb.checked);

    // Evitar “ninguna seleccionada”: vuelve a todas
    if (noneChecked) {
      cbs.forEach((cb) => (cb.checked = true));
      allCb.checked = true;
    } else {
      allCb.checked = allChecked;
    }

    updateSectionsButtonText();
    applyFilters(false);
  });

  function updateSectionsButtonText() {
    const selected = getSelectedSections();
    btn.textContent = selected === "ALL" ? "Secciones (todas)" : `Secciones (${selected.length})`;
  }

  updateSectionsButtonText();
}

function getSelectedSections() {
  const cbs = Array.from(document.querySelectorAll(".sec-cb"));
  if (!cbs.length) return "ALL";

  const selected = cbs.filter((cb) => cb.checked).map((cb) => cb.dataset.section);
  if (selected.length === cbs.length) return "ALL";
  return selected;
}

// ------------------ Filtro visitadas ------------------
function getStatusFilter() {
  const el = document.getElementById("statusFilter");
  return el ? el.value : "ALL";
}

// ------------------ Render pins ------------------
function renderMarkers(fallas) {
  layerGroup.clearLayers();
  markers = [];

  const state = loadState();
  const bounds = L.latLngBounds([]);

  for (const f of fallas) {
    const lat = Number(String(f.lat).replace(",", "."));
    const lng = Number(String(f.lng).replace(",", "."));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const fallaNum = Number(f.falla_number);
    if (!Number.isFinite(fallaNum)) continue;

    const key = keyForFallaNumber(fallaNum);
    const cur = state[key] || { visited: false, wish: false, rating_major: 0, rating_child: 0 };

    const popupHtml = `
      <div class="popup" style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;">
        <div class="popuptitle"><strong>${fallaNum}</strong> | ${f.name ?? ""}</div>
 
        <div class="seccion">Sección: <strong>${f.section ?? ""}</strong></div>

        <hr style="border:none;border-top:1px solid #eee;margin:8px 0;">

       
       ${
          f.sketch_url
            ? `<img src="${f.sketch_url}" alt="Boceto" />`
            : ""
        }

        <hr style="border:none;border-top:1px solid #eee;margin:8px 0;">
       
        <div class="checks-row">
        <label class="visited">
          <input type="checkbox" id="v_${key}" ${cur.visited ? "checked" : ""} />
          <span>Visitada</span>
        </label>

       <label class="wishlist">
       <input type="checkbox" id="w_${key}" ${cur.wish ? "checked" : ""} />
          <span>Quiero verla</span>
       </label>
       </div>

        <div style="margin-top:8px; display:grid; gap:6px;">
          <label class="valorargrande" style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span>Grande (0–10)</span>
            <input type="number" id="m_${key}" min="0" max="10" step="1"
              value="${cur.rating_major}" style="width:80px;padding:6px;border-radius:10px;border:1px solid #ddd;">
          </label>

          <label class="valorarinfantil" style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span>Infantil (0–10)</span>
            <input type="number" id="c_${key}" min="0" max="10" step="1"
              value="${cur.rating_child}" style="width:80px;padding:6px;border-radius:10px;border:1px solid #ddd;">
          </label>

          <button class="savebutton" id="s_${key}"
            style="padding:8px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer;font-weight:600;">
            Guardar
          </button>
        </div>
       
      </div>
    `;

    const marker = L.marker(
      [lat, lng],
      { icon: createFallaIcon(f.section, cur.visited) }
    ).bindPopup(popupHtml);

    marker.on("popupopen", (e) => {
      centerPopup(e.target);
      const v = document.getElementById(`v_${key}`);
      const m = document.getElementById(`m_${key}`);
      const c = document.getElementById(`c_${key}`);
      const s = document.getElementById(`s_${key}`);
      const w = document.getElementById(`w_${key}`);
      if (!s) return;

      s.onclick = () => {
        const next = loadState();
        next[key] = {
          visited: !!(v && v.checked),
          wish: !!(w && w.checked),
          rating_major: clampInt(m?.value, 0, 10, 0),
          rating_child: clampInt(c?.value, 0, 10, 0),
        };
        saveState(next);

        // Actualiza icono visual al instante
        marker.setIcon(createFallaIcon(f.section, next[key].visited));

        s.textContent = "✅ Guardado";
        setTimeout(() => (s.textContent = "Guardar"), 900);

        // Refresca filtros si está en "visitadas/no visitadas"
        applyFilters(false);
      };
    });

    marker.addTo(layerGroup);
    markers.push({ marker, falla_number: fallaNum, section: f.section });
    bounds.extend([lat, lng]);
  }

  if (markers.length) map.fitBounds(bounds.pad(0.2));
}

function centerPopup(marker) {
  if (!map) return;

  const latLng = marker.getLatLng();

  // Convertimos a coordenadas de pantalla
  const point = map.latLngToContainerPoint(latLng);

  // Offset vertical (ajusta si quieres)
  const offsetY = window.innerWidth < 600 ? 160 : 120;
 // mueve hacia abajo el centro visible

  const targetPoint = L.point(point.x, point.y - offsetY);
  const targetLatLng = map.containerPointToLatLng(targetPoint);

  map.panTo(targetLatLng, {
    animate: true,
    duration: 0.4
  });
}


// ------------------ Aplicar filtros ------------------
function applyFilters(clearRouteToo = true) {
  const q = normalize(document.getElementById("textFilter")?.value ?? "");
  const statusFilter = getStatusFilter();
  const selectedSections = getSelectedSections();
  const state = loadState();

  let filtered = allFallas;

  // Secciones seleccionadas
  if (selectedSections !== "ALL") {
    const set = new Set(selectedSections);
    filtered = filtered.filter((f) => set.has(f.section));
  }

  // Búsqueda
  if (q) {
    filtered = filtered.filter((f) => {
      const haystack = normalize(`${f.name} ${f.falla_number} ${f.section}`);
      return haystack.includes(q);
    });
  }

  // Visitadas / no visitadas
if (statusFilter !== "ALL") {
  filtered = filtered.filter((f) => {
    const key = keyForFallaNumber(f.falla_number);
    const visited = !!state[key]?.visited;
    const wish = !!state[key]?.wish;

    if (statusFilter === "VISITED") return visited;
    if (statusFilter === "NOT_VISITED") return !visited;
    if (statusFilter === "WISH") return wish;

    return true;
  });
  }

  renderMarkers(filtered);
  if (clearRouteToo) clearRoute();
}

// ------------------ Cargar datos ------------------
async function loadData() {
  try {
    // anti-cache en desarrollo
    const res = await fetch("./data/fallas.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} al cargar ./data/fallas.json`);
    allFallas = await res.json();
  } catch (err) {
    // Si abres el HTML con file://, el navegador bloquea fetch() por CORS.
    const hint = (location.protocol === "file:")
      ? "Estás abriendo la app con file://. Usa un servidor local (p.ej. `python3 -m http.server 8000`) y entra por http://localhost:8000"
      : "";
    console.error("❌ Error cargando fallas.json:", err);
    showFatalError("No se han podido cargar los datos (fallas.json). " + (hint ? ("\n\n" + hint) : ""));
    throw err;
  }
}

// ------------------ Ruta ------------------
let routeLine = null;

function clearRoute() {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
}

function getRouteBudgetMeters() {
  const timeEl = document.getElementById("timeMin");
  const speedEl = document.getElementById("speedKmh");

  const minutes = clampNum(timeEl?.value, 1, 600, 45);
  const kmh = clampNum(speedEl?.value, 2, 10, 4.5);

  const metersPerMin = (kmh * 1000) / 60;
  const maxMeters = minutes * metersPerMin;

  return { minutes, kmh, maxMeters };
}

function shouldIgnoreVisitedForRoute() {
  const el = document.getElementById("ignoreVisitedChk");
  return !!(el && el.checked);
}

function buildOptimizedRoute(origin, points, maxMeters) {
  const remaining = [...points];
  const route = [];

  let current = origin;
  let usedMeters = 0;

  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const d = distanceMeters(current, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    if (Number.isFinite(maxMeters) && maxMeters > 0) {
      if (usedMeters + bestDist > maxMeters) break;
    }

    const next = remaining.splice(bestIdx, 1)[0];
    route.push(next);
    usedMeters += bestDist;
    current = next;
  }

  return { route, usedMeters };
}

function drawRoute(origin, route) {
  clearRoute();
  const coords = [[origin.lat, origin.lng], ...route.map((p) => [p.lat, p.lng])];

  routeLine = L.polyline(coords, {
    color: "#ff2d55",
    weight: 4,
    opacity: 0.8,
  }).addTo(map);

  map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
}

function buildRoute() {
  const origin = getOrigin();
  if (!origin) {
    alert("Elige un inicio: 📍 Mi ubicación o 🎯 Elegir inicio.");
    return;
  }

  const { minutes, kmh, maxMeters } = getRouteBudgetMeters();
  const ignoreVisited = shouldIgnoreVisitedForRoute();
  const state = loadState();

  // Puntos visibles (ya filtrados por el mapa)
  let points = markers.map((obj) => {
    const ll = obj.marker.getLatLng();
    return { lat: ll.lat, lng: ll.lng, falla_number: obj.falla_number };
  });

  if (ignoreVisited) {
    points = points.filter((p) => !state[keyForFallaNumber(p.falla_number)]?.visited);
  }

  if (!points.length) {
    alert("No hay fallas disponibles para crear ruta (revisa filtros o ignora visitadas).");
    return;
  }

  const { route, usedMeters } = buildOptimizedRoute(origin, points, maxMeters);

  if (!route.length) {
    alert("Con ese tiempo/distancia no entra ninguna falla. Sube minutos o reduce filtros.");
    return;
  }

  drawRoute(origin, route);

  const metersPerMin = (kmh * 1000) / 60;
  const estMin = Math.round(usedMeters / metersPerMin);

  alert(
    `Ruta creada:\n` +
      `• Inicio: ${origin.label}\n` +
      `• Paradas: ${route.length}\n` +
      `• Ignorar visitadas: ${ignoreVisited ? "Sí" : "No"}\n` +
      `• Distancia aprox: ${Math.round(usedMeters)} m\n` +
      `• Tiempo estimado: ~${estMin} min`
  );
}

// ------------------ Panel de ruta (toggle) ------------------
function setupRoutePanelToggle() {
  const routeToggleBtn = document.getElementById("routeToggleBtn");
  const routePanel = document.getElementById("routePanel");
  const routeCloseBtn = document.getElementById("routeCloseBtn");
  if (!routeToggleBtn || !routePanel) return;

  const close = () => routePanel.classList.add("hidden");
  const toggle = () => routePanel.classList.toggle("hidden");

  // Mejor pointerdown que click en móvil
  routeToggleBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }, true);

  if (routeCloseBtn) {
    routeCloseBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    }, true);
  }

  // Cerrar al tocar fuera
  document.addEventListener("pointerdown", (e) => {
    if (routePanel.classList.contains("hidden")) return;
    if (!routePanel.contains(e.target) && e.target !== routeToggleBtn) {
      close();
    }
  }, true);
}



// ------------------ Main ------------------

const el = document.getElementById("appVersion");
if (el) el.textContent = APP_VERSION;

(async function main() {
  initMap();
  await loadData();

  buildSectionFilter(allFallas);
  applyFilters();

  document.getElementById("textFilter")?.addEventListener("input", () => applyFilters(false));
  document.getElementById("statusFilter")?.addEventListener("change", () => applyFilters());

  document.getElementById("locateBtn")?.addEventListener("click", locateUser);
  document.getElementById("pickStartBtn")?.addEventListener("click", enablePickStartMode);
  document.getElementById("routeBtn")?.addEventListener("click", buildRoute);
  document.getElementById("clearRouteBtn")?.addEventListener("click", clearRoute);

  setupRoutePanelToggle();

  map.on("click", (e) => {
    if (!pickStartMode) return;
    setStartPoint(e.latlng.lat, e.latlng.lng);
  });
})().catch((err) => {
  console.error(err);
  alert("Error cargando la app. Mira la consola para más detalle.");
});

// Colapsar panel superior izquierdo
window.addEventListener("DOMContentLoaded", () => {
  const bar = document.getElementById("topbar");
  const btn = document.getElementById("topbarToggle");

  if (!bar || !btn) return;

  btn.addEventListener("click", () => {
    const collapsed = bar.classList.toggle("collapsed");
    btn.textContent = collapsed ? "▸" : "▾";
  });
});
