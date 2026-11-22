"use strict";

// ============================================================
// SUPABASE AUTHENTICATION & LOGIN GATE - GENERADOR DE APUNTES
// ============================================================

// Prioridad: variable ya establecida > backend (/api/configuracion) > config-publica.js > localStorage
window.SUPABASE_URL = window.SUPABASE_URL
  || (window.APP_CONFIG && window.APP_CONFIG.supabaseUrl)
  || (typeof localStorage !== "undefined" && localStorage.getItem("supabase_url"))
  || "";
window.SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY
  || (window.APP_CONFIG && window.APP_CONFIG.supabaseAnonKey)
  || (typeof localStorage !== "undefined" && localStorage.getItem("supabase_anon_key"))
  || "";

const SupabaseAuth = (() => {
  let client = null;
  let currentUser = null;

  function getClient() {
    if (client) return client;
    if (typeof window.supabase !== "undefined" && typeof window.supabase.createClient === "function") {
      try {
        client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            // flowType 'implicit': el token vuelve en la URL (#access_token=...) sin
            // verificar PKCE state en localStorage — necesario porque Supabase puede
            // redirigir a localhost:3000 (Site URL) siendo el origen localhost:8002,
            // y localStorage NO se comparte entre puertos.
            flowType: "implicit",
          },
        });
        window.supabaseClient = client;
        return client;
      } catch (err) {
        console.error("Error al inicializar Supabase:", err);
      }
    }
    return null;
  }

  function getCurrentUser() {
    return currentUser;
  }

  function mostrarLoginGate(errorMsg = "") {
    const gate = document.getElementById("login-gate");
    if (gate) {
      gate.style.display = "flex";
      const errBox = document.getElementById("login-gate-error");
      if (errBox) {
        if (errorMsg) {
          errBox.textContent = errorMsg;
          errBox.style.display = "block";
        } else {
          errBox.style.display = "none";
        }
      }
    }
    const appEl = document.querySelector(".app-layout") || document.querySelector("main");
    if (appEl) {
      appEl.style.filter = "blur(4px)";
      appEl.style.pointerEvents = "none";
    }
  }

  function ocultarLoginGate() {
    const gate = document.getElementById("login-gate");
    if (gate) gate.style.display = "none";
    const appEl = document.querySelector(".app-layout") || document.querySelector("main");
    if (appEl) {
      appEl.style.filter = "";
      appEl.style.pointerEvents = "";
    }
  }

  function updateAuthButton() {
    const btn = document.querySelector("#auth-btn");
    const label = document.querySelector("#auth-btn-label");
    if (!btn || !label) return;

    if (currentUser) {
      const email = currentUser.email || "Usuario";
      label.textContent = email.split("@")[0];
      btn.classList.add("primary");
      btn.title = `Conectado como ${email} · Clic para ver perfil y cerrar sesión`;
    } else {
      label.textContent = "Iniciar sesión";
      btn.classList.remove("primary");
      btn.title = "Iniciar sesión con Supabase";
    }
  }

  function renderAuthModal() {
    let modal = document.querySelector("#auth-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "auth-modal";
      modal.style.cssText = `
        position: fixed; inset: 0; background: rgba(15, 23, 42, 0.75);
        display: flex; align-items: center; justify-content: center; z-index: 1000000;
        padding: 20px; backdrop-filter: blur(4px); font-family: inherit;
      `;
      document.body.appendChild(modal);
    }

    modal.style.display = "flex";
    const user = currentUser;
    const email = user?.email || "Sin email";

    modal.innerHTML = `
      <div style="
        background: #111827; color: #f9fafb; border: 1px solid #374151;
        border-radius: 16px; width: 100%; max-width: 420px; padding: 24px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); position: relative;
      ">
        <button type="button" id="close-auth-modal" style="
          position: absolute; top: 14px; right: 16px; background: none; border: none;
          font-size: 22px; color: #9ca3af; cursor: pointer; padding: 4px; line-height: 1;
        " aria-label="Cerrar">&times;</button>

        <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
          <div style="width:42px; height:42px; border-radius:12px; background:rgba(37,99,235,0.15); color:#60a5fa; display:flex; align-items:center; justify-content:center; font-size:20px;">
            <i class="fa-solid fa-user-shield"></i>
          </div>
          <div>
            <h3 style="margin:0; font-size:17px; font-weight:600; color:#fff;">Cuenta de Supabase</h3>
            <p style="margin:2px 0 0; font-size:12px; color:#9ca3af;">Acceso verificado · Grados Informáticos</p>
          </div>
        </div>

        <div style="background:#1f2937; border:1px solid #374151; border-radius:10px; padding:14px; margin-bottom:18px;">
          <div style="font-size:11px; text-transform:uppercase; color:#9ca3af; letter-spacing:0.5px; margin-bottom:4px;">Usuario conectado</div>
          <div style="font-size:14px; font-weight:600; color:#fff; word-break:break-all;">${email}</div>
          <div style="margin-top:8px; display:inline-flex; align-items:center; gap:6px; font-size:11px; padding:2px 8px; border-radius:4px; background:rgba(34,197,94,0.15); color:#86efac;">
            <i class="fa-solid fa-circle-check"></i> Sesión activa y sincronizada
          </div>
        </div>

        <div style="display:flex; gap:10px;">
          <button id="btn-cerrar-sesion" type="button" style="
            flex: 1; padding: 10px 16px; background: #dc2626; color: #fff;
            border: none; border-radius: 8px; font-size: 13.5px; font-weight: 600;
            cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
          ">
            <i class="fa-solid fa-right-from-bracket"></i>
            <span>Cerrar sesión</span>
          </button>
        </div>
      </div>
    `;

    modal.querySelector("#close-auth-modal")?.addEventListener("click", () => {
      modal.style.display = "none";
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });

    modal.querySelector("#btn-cerrar-sesion")?.addEventListener("click", async () => {
      await cerrarSesion();
      modal.style.display = "none";
    });
  }

  async function cerrarSesion() {
    const c = getClient();
    if (c) {
      try {
        await c.auth.signOut();
      } catch (_) {}
    }
    currentUser = null;
    try { sessionStorage.clear(); } catch (_) {}
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.startsWith("sb-") || k.includes("supabase") || k.includes("auth"))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}
    updateAuthButton();
    mostrarLoginGate("Has cerrado sesión.");
  }

  async function verificarPermisoAdmin(c, user) {
    if (!user) return false;
    const emailNorm = String(user.email || "").trim().toLowerCase();
    if (emailNorm === "nataliagbarea@gmail.com" || user.id === "553ae2cb-4832-4cda-a16d-e547032eb5b7") {
      return true;
    }

    try {
      const u = window.SUPABASE_URL;
      const k = window.SUPABASE_ANON_KEY;
      if (u && k) {
        const idFiltro = user.id ? `id=eq.${encodeURIComponent(user.id)}` : `email=eq.${encodeURIComponent(user.email)}`;
        const resp = await fetch(`${u}/rest/v1/perfiles?select=rol&${idFiltro}`, {
          credentials: "omit",
          headers: { apikey: k, Authorization: `Bearer ${k}` },
        });
        if (resp.ok) {
          const arr = await resp.json();
          if (Array.isArray(arr) && arr.length > 0 && String(arr[0].rol || "").trim().toLowerCase() === "admin") {
            return true;
          }
        }
      }
    } catch (_) {}

    if (!c) return false;
    try {
      let data = null;
      if (user.id) {
        const resId = await c.schema("public").from("perfiles").select("id, email, rol").eq("id", user.id).maybeSingle();
        if (!resId.error && resId.data) data = resId.data;
      }
      if (!data && user.email) {
        const resEmail = await c.schema("public").from("perfiles").select("id, email, rol").eq("email", user.email).maybeSingle();
        if (!resEmail.error && resEmail.data) data = resEmail.data;
      }
      return data && String(data.rol || "").trim().toLowerCase() === "admin";
    } catch (_) {
      return false;
    }
  }

  async function autenticarConGate() {
    const c = getClient();
    if (!c) {
      mostrarLoginGate("No se pudo conectar con Supabase. Revisa tu conexión.");
      return false;
    }

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const hasError = urlParams.has("error") || urlParams.has("error_description");
      if (hasError) {
        const errDesc = urlParams.get("error_description") || urlParams.get("error") || "Error en autorización";
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch (_) {}
        mostrarLoginGate(`Aviso: ${decodeURIComponent(errDesc).replace(/\+/g, " ")}`);
        return false;
      }

      let { data: { session } } = await c.auth.getSession();
      const hasTokenInUrl = window.location.hash.includes("access_token") || window.location.search.includes("code=");

      if (!session && hasTokenInUrl) {
        if (window.location.search.includes("code=")) {
          const code = urlParams.get("code");
          if (code && typeof c.auth.exchangeCodeForSession === "function") {
            try {
              const resCode = await c.auth.exchangeCodeForSession(code);
              if (resCode.data?.session) session = resCode.data.session;
            } catch (_) {}
          }
        }
        if (!session) {
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const res = await c.auth.getSession();
            if (res.data?.session) {
              session = res.data.session;
              break;
            }
          }
        }
      }

      if (!session?.user) {
        mostrarLoginGate();
        return false;
      }

      if (hasTokenInUrl) {
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch (_) {}
      }

      const esAdmin = await verificarPermisoAdmin(c, session.user);
      if (!esAdmin) {
        await c.auth.signOut().catch(() => {});
        currentUser = null;
        mostrarLoginGate(`Acceso denegado: tu usuario (${session.user.email || session.user.id}) no tiene rol admin en Supabase.`);
        return false;
      }

      currentUser = session.user;
      ocultarLoginGate();
      updateAuthButton();
      return true;
    } catch (err) {
      console.error("Error autenticando:", err);
      mostrarLoginGate("Error al validar la sesión.");
      return false;
    }
  }

  async function init() {
    // Solo intentar /api/configuracion si no estamos en GitHub Pages / entorno estático
    const esEstatico = typeof window !== "undefined" && (
      window.location.protocol === "file:" ||
      window.location.hostname.endsWith("github.io") ||
      window.location.hostname.endsWith("pages.dev")
    );
    if (!esEstatico) {
      try {
        const res = await fetch("/api/configuracion");
        if (res.ok) {
          const texto = await res.text();
          if (texto && !texto.trim().startsWith("<")) {
            const cfg = JSON.parse(texto);
            if (cfg.supabaseUrl) window.SUPABASE_URL = cfg.supabaseUrl;
            if (cfg.supabaseAnonKey) window.SUPABASE_ANON_KEY = cfg.supabaseAnonKey;
          }
        }
      } catch (_) {}
    }

    // Gate email login submit
    const gateForm = document.getElementById("gate-email-form");
    gateForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const c = getClient();
      if (!c) {
        mostrarLoginGate("Cliente Supabase no disponible.");
        return;
      }
      const emailInput = document.getElementById("gate-input-email");
      const passInput = document.getElementById("gate-input-password");
      const submitBtn = document.getElementById("gate-btn-submit-email");
      const errBox = document.getElementById("login-gate-error");

      const email = emailInput?.value.trim();
      const password = passInput?.value;
      if (!email || !password) return;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Verificando credenciales…";
      }
      if (errBox) errBox.style.display = "none";

      try {
        const { data, error } = await c.auth.signInWithPassword({ email, password });
        if (error) {
          if (errBox) {
            errBox.textContent = `Error: ${error.message}`;
            errBox.style.display = "block";
          }
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Iniciar sesión";
          }
          return;
        }

        const esAdmin = await verificarPermisoAdmin(c, data.user);
        if (!esAdmin) {
          await c.auth.signOut().catch(() => {});
          currentUser = null;
          if (errBox) {
            errBox.textContent = `Acceso denegado: tu usuario (${email}) no tiene rol admin en Supabase.`;
            errBox.style.display = "block";
          }
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Iniciar sesión";
          }
          return;
        }

        currentUser = data.user;
        try { localStorage.removeItem("auth_origin_app"); } catch (_) {}
        ocultarLoginGate();
        updateAuthButton();
      } catch (errSubmit) {
        if (errBox) {
          errBox.textContent = `Error al conectar: ${errSubmit.message}`;
          errBox.style.display = "block";
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Iniciar sesión";
        }
      }
    });

    // Gate OAuth buttons
    document.getElementById("gate-btn-google")?.addEventListener("click", async () => {
      const c = getClient();
      if (!c) return;
      const redirectUrl = window.location.origin + window.location.pathname;
      // Cookie compartida entre puertos de localhost (localStorage NO se comparte entre puertos)
      try {
        document.cookie = `auth_origin_app=${encodeURIComponent(window.location.href)}; path=/; samesite=lax; max-age=300`;
        localStorage.setItem("auth_origin_app", window.location.href);
      } catch (_) {}
      await c.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: redirectUrl },
      });
    });

    document.getElementById("gate-btn-github")?.addEventListener("click", async () => {
      const c = getClient();
      if (!c) return;
      const redirectUrl = window.location.origin + window.location.pathname;
      // Cookie compartida entre puertos de localhost (localStorage NO se comparte entre puertos)
      try {
        document.cookie = `auth_origin_app=${encodeURIComponent(window.location.href)}; path=/; samesite=lax; max-age=300`;
        localStorage.setItem("auth_origin_app", window.location.href);
      } catch (_) {}
      await c.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: redirectUrl },
      });
    });

    // Header auth button
    document.getElementById("auth-btn")?.addEventListener("click", () => {
      if (currentUser) {
        renderAuthModal();
      } else {
        mostrarLoginGate();
      }
    });

    await autenticarConGate();

    const c = getClient();
    if (c) {
      c.auth.onAuthStateChange(async (event, session) => {
        if (event === "SIGNED_IN" && session?.user) {
          await autenticarConGate();
        } else if (event === "SIGNED_OUT") {
          currentUser = null;
          updateAuthButton();
          mostrarLoginGate();
        }
      });
    }
  }

  return {
    init,
    getClient,
    getCurrentUser,
    mostrarLoginGate,
    ocultarLoginGate,
    cerrarSesion,
    renderAuthModal,
  };
})();

window.SupabaseAuth = SupabaseAuth;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => SupabaseAuth.init());
} else {
  SupabaseAuth.init();
}
