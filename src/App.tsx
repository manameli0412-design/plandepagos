import React, { useEffect, useMemo, useState } from "react";

// Manamelí – Prototipo Calculadora de Plan de Pagos (con soporte PWA)
// - Extras reemplazan la mensualidad del mes N.
// - Todas las mensualidades restantes son iguales (redondeadas) excluyendo inicial, extras y balloon.
// - Sin columna de saldo. Se agrega Fecha calculada a partir de "Inicio del plan (mes)".
// - CSV exporta: Tipo, Mes, Fecha, Concepto, Valor.
// - Auto‑tests en consola para validar invariantes.
// - **PWA**: manifest inyectado y Service Worker registrado en runtime; banner de “Instalar app”.

// =====================
// Utilidades
// =====================
const currency = (v: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(v) ? v : 0);

const clamp = (val: number, min: number, max: number) =>
  Math.max(min, Math.min(max, val));

// Redondeos a múltiplos
function roundCeilToMultiple(n: number, mult: number) {
  if (!mult || mult <= 0) return Math.ceil(n);
  return Math.ceil(n / mult) * mult;
}
function roundFloorToMultiple(n: number, mult: number) {
  if (!mult || mult <= 0) return Math.floor(n);
  return Math.floor(n / mult) * mult;
}

const safeUUID = () =>
  globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random()}`;
const defaultExtra = () => ({ id: safeUUID(), month: 12, amount: 0 });

// Precio base de referencia para descuento (no editable)
const BASE_PRICE_PER_M2 = 365000;

// =====================
// Fechas (mes-a-mes)
// =====================
const monthNamesEs = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
function formatMonthEs(date: Date) {
  const m = monthNamesEs[date.getUTCMonth()];
  const y = date.getUTCFullYear();
  return `${m} ${y}`;
}
function addMonths(date: Date, months: number) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
function parseMonthStr(ym: string) {
  // ym: "YYYY-MM"
  const [yS, mS] = ym.split("-");
  const y = Number(yS);
  const m = Number(mS);
  return new Date(Date.UTC(y, (m || 1) - 1, 1));
}
function defaultMonthString() {
  const now = new Date();
  const nxt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  const y = nxt.getUTCFullYear();
  const m = String(nxt.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Fecha por defecto para la cotización (YYYY-MM-DD)
function defaultDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Polyfill simple para groupBy si no está disponible
function groupByPolyfill<T>(arr: T[], fn: (x: T) => string | number) {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const key = String(fn(item));
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

// =====================
// PWA helpers (manifest + SW runtime)
// =====================
function injectManifestOnce() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[rel="manifest"]')) return;
  const manifest = {
    name: "Manamelí – Calculadora",
    short_name: "Manamelí",
    start_url: ".",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#065f46", // ~emerald-700
    description: "Simulador de plan de pagos Manamelí",
    icons: [
      // Puedes reemplazar estas rutas por /logo-manameli-192.png y /logo-manameli-512.png en producción
      { src: "/logo-manameli-192.png", sizes: "192x192", type: "image/png" },
      { src: "/logo-manameli-512.png", sizes: "512x512", type: "image/png" },
    ],
  } as const;
  const blob = new Blob([JSON.stringify(manifest)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = url;
  document.head.appendChild(link);
}

function registerServiceWorker() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  // Evitar registrar 2 veces
  if ((navigator.serviceWorker as any)._manameliRegistered) return;

  const swCode = `
    const CACHE_NAME = 'manameli-calculadora-v1';
    const OFFLINE_URLS = [
      './',
    ];
    self.addEventListener('install', (event) => {
      event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(OFFLINE_URLS);
        self.skipWaiting();
      })());
    });
    self.addEventListener('activate', (event) => {
      event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => k === CACHE_NAME ? undefined : caches.delete(k)));
        self.clients.claim();
      })());
    });
    self.addEventListener('fetch', (event) => {
      const { request } = event;
      if (request.method !== 'GET') return;
      event.respondWith((async () => {
        try {
          const netRes = await fetch(request);
          // Opcional: cachear copias de navegación
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, netRes.clone());
          return netRes;
        } catch (err) {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(request);
          if (cached) return cached;
          // Fallback al index para rutas SPA
          return cache.match('./');
        }
      })());
    });
  `;
  const blob = new Blob([swCode], { type: "text/javascript" });
  const swUrl = URL.createObjectURL(blob);
  navigator.serviceWorker
    .register(swUrl)
    .then(() => {
      (navigator.serviceWorker as any)._manameliRegistered = true;
      // noop
    })
    .catch(() => {
      // Silencioso: en orígenes no seguros (http) no registra
    });
}

function usePWAInstallPrompt() {
  const [deferred, setDeferred] = useState<any>(null);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferred(e);
      setSupported(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  const promptInstall = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };
  return { canInstall: supported && !!deferred, promptInstall } as const;
}

// =====================
// Componente principal
// =====================
export default function PaymentPlanner() {
  // Registrar PWA (manifest + SW) una vez montado
  useEffect(() => {
    try {
      injectManifestOnce();
    } catch {}
    try {
      registerServiceWorker();
    } catch {}
  }, []);

  const { canInstall, promptInstall } = usePWAInstallPrompt();

  // Entradas base
  const [area, setArea] = useState<number>(500); // m²
  const [pricePerM2, setPricePerM2] = useState<number>(350000); // COP/m²
  // El descuento ya NO es porcentaje: se calcula como (BASE 365k - precio negociado) * área

  // Generar opciones discretas de precio/m²: desde 365.000 bajando de 5.000 en 5.000 hasta 280.000
  const pricePerM2Options = useMemo<number[]>(() => {
    const arr: number[] = [];
    for (let v = 365000; v >= 280000; v -= 5000) arr.push(v);
    return arr;
  }, []);

  // Estructura del plan
  const [months, setMonths] = useState<number>(36);
  const [balloonPct, setBalloonPct] = useState<number>(25); // % última cuota (balloon)
  const [initialPayment, setInitialPayment] = useState<number>(20000000);

  // Inicio del plan (mes)
  const [startMonth, setStartMonth] = useState<string>(defaultMonthString());

  // Datos de encabezado de cotización
  const [quoteDate, setQuoteDate] = useState<string>(defaultDateString());
  const [clientName, setClientName] = useState<string>("");
  const [clientPhone, setClientPhone] = useState<string>("");
  const [clientEmail, setClientEmail] = useState<string>("");
  const [lotNumber, setLotNumber] = useState<string>("");

  // Redondeo de mensualidades (0 = sin redondeo)
  const [roundingMultiple, setRoundingMultiple] = useState<number>(0);

  // Cuotas extraordinarias
  const [extras, setExtras] = useState<
    { id: string; month: number; amount: number }[]
  >([defaultExtra()]);

  // Cálculos de precio
  // Precio full SIEMPRE con base 365.000 COP/m²
  const fullPrice = useMemo(
    () => clamp(area, 1, 1_000_000) * BASE_PRICE_PER_M2,
    [area]
  );
  // Precio negociado proviene del selector de precio/m²
  const negotiatedPrice = useMemo(
    () => clamp(area, 1, 1_000_000) * clamp(pricePerM2, 0, 100_000_000),
    [area, pricePerM2]
  );
  // Descuento = diferencia entre base (365k) y negociado, por área. No negativo.
  const discountAmount = useMemo(
    () => Math.max(0, fullPrice - negotiatedPrice),
    [fullPrice, negotiatedPrice]
  );
  // Precio neto = precio negociado
  const netPrice = useMemo(() => negotiatedPrice, [negotiatedPrice]);

  // Validaciones del flujo de efectivo
  const balloonValue = useMemo(
    () => (netPrice * clamp(balloonPct, 0, 90)) / 100,
    [netPrice, balloonPct]
  );
  const cappedInitial = useMemo(
    () => clamp(initialPayment, 0, Math.max(0, netPrice)),
    [netPrice, initialPayment]
  );

  // Ordenar extraordinarias por mes y limitar
  const orderedExtras = useMemo(() => {
    const copy = [...extras].filter((e) => e.amount > 0 && e.month >= 1);
    copy.sort((a, b) => a.month - b.month);
    return copy;
  }, [extras]);

  // Construcción del calendario de pagos (extras reemplazan mensualidad)
  const schedule = useMemo(() => {
    const M = clamp(months, 1, 240);
    type Row = {
      type: "initial" | "monthly" | "extra" | "balloon";
      label: string;
      month: number;
      amount: number;
    };
    const rows: Row[] = [];

    // Extraordinarias válidas dentro del rango [1..M]
    const validExtras = orderedExtras.filter(
      (e) => e.amount > 0 && e.month >= 1 && e.month <= M
    );
    const extrasSum = validExtras.reduce((s, e) => s + e.amount, 0);

    // Base distribuible en mensualidades igualitarias (sin inicial, sin extras, sin balloon)
    const baseForMonthly = Math.max(
      0,
      netPrice - cappedInitial - balloonValue - extrasSum
    );
    const numMonthlyPayments = Math.max(0, M - validExtras.length);

    // Cálculo de mensualidad con redondeo uniforme y ajuste en balloon
    let monthlyInstallment = 0;
    let adjustedBalloon = balloonValue;

    if (numMonthlyPayments > 0) {
      const raw = baseForMonthly / numMonthlyPayments;
      // Redondear hacia arriba al múltiplo solicitado (si 0 => usar ceil normal)
      const candidateUp = roundCeilToMultiple(raw, roundingMultiple);
      let totalMonthlyUp = candidateUp * numMonthlyPayments;
      let balloonAfterUp = balloonValue - (totalMonthlyUp - baseForMonthly); // puede bajar el balloon

      if (balloonAfterUp >= 0) {
        monthlyInstallment = candidateUp;
        adjustedBalloon = balloonAfterUp;
      } else {
        // Si con redondeo hacia arriba se vuelve negativo el balloon, intentar con floor
        const candidateDown = Math.max(
          0,
          roundFloorToMultiple(raw, roundingMultiple)
        );
        monthlyInstallment = candidateDown;
        const totalMonthlyDown = candidateDown * numMonthlyPayments;
        adjustedBalloon = balloonValue + (baseForMonthly - totalMonthlyDown);
        // Asegurar no negativo por redondeos extremos
        adjustedBalloon = Math.max(0, adjustedBalloon);
      }
    }

    // Registrar inicial
    rows.push({
      type: "initial",
      label: "Cuota inicial",
      month: 0,
      amount: cappedInitial,
    });

    const extrasByMonth = groupByPolyfill(validExtras, (e) => e.month);

    // Construir calendario: si hay extraordinaria en un mes N, REEMPLAZA la mensualidad del mes N
    for (let m = 1; m <= M; m++) {
      const list = extrasByMonth[String(m)] || [];
      if (list.length) {
        for (const ex of list) {
          rows.push({
            type: "extra",
            label: `Extraordinaria (mes ${m})`,
            month: m,
            amount: ex.amount,
          });
        }
        // No se agrega mensualidad este mes
      } else {
        rows.push({
          type: "monthly",
          label: `Cuota mensual ${m}`,
          month: m,
          amount: monthlyInstallment,
        });
      }
    }

    // Registrar balloon (ajustado si hubo redondeo)
    rows.push({
      type: "balloon",
      label: "Última cuota (balloon)",
      month: M + 1,
      amount: adjustedBalloon,
    });

    return rows;
  }, [
    netPrice,
    cappedInitial,
    balloonValue,
    months,
    orderedExtras,
    roundingMultiple,
  ]);

  const totals = useMemo(() => {
    const monthlyTotal = schedule
      .filter((r) => r.type === "monthly")
      .reduce((s, r) => s + r.amount, 0);
    const extrasTotal = schedule
      .filter((r) => r.type === "extra")
      .reduce((s, r) => s + r.amount, 0);
    const initial = schedule.find((r) => r.type === "initial")?.amount ?? 0;
    const balloon = schedule.find((r) => r.type === "balloon")?.amount ?? 0;
    const grand = initial + monthlyTotal + extrasTotal + balloon;
    return { monthlyTotal, extrasTotal, initial, balloon, grand };
  }, [schedule]);

  // Agregar FECHAS a cada fila del calendario según startMonth
  const scheduleWithDates = useMemo(() => {
    const base = parseMonthStr(startMonth);
    return schedule.map((r) => {
      const offset = Math.max(0, r.month - 1); // 0 para inicial; (m-1) para mensual/extra; M para balloon
      const d = formatMonthEs(addMonths(base, offset));
      return { ...r, date: d };
    });
  }, [schedule, startMonth]);

  // Export CSV
  const csvHref = useMemo(() => {
    const headers = ["Tipo", "Mes", "Fecha", "Concepto", "Valor"].join(",");
    const lines = scheduleWithDates.map((r) =>
      [r.type, r.month, r.date, r.label, r.amount].join(",")
    );
    const csv = [headers, ...lines].join("\n");
    return URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  }, [scheduleWithDates]);

  // UI helpers
  const addExtra = () => setExtras((xs) => [...xs, defaultExtra()]);
  const removeExtra = (id: string) =>
    setExtras((xs) => xs.filter((x) => x.id !== id));
  const updateExtra = (
    id: string,
    patch: Partial<{ month: number; amount: number }>
  ) => setExtras((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  // --- Auto‑tests en consola (no afectan UI) ---
  useEffect(() => {
    // Test 1: Suma de todas las partidas debe igualar netPrice (±1 por redondeo)
    const sum = totals.grand;
    const ok1 = Math.abs(sum - netPrice) <= 1;

    // Test 2: Los meses con extraordinaria no deben tener mensualidad
    const monthsWithExtra = new Set(orderedExtras.map((e) => e.month));
    const clash = schedule.some(
      (r) => r.type === "monthly" && monthsWithExtra.has(r.month)
    );
    const ok2 = !clash;

    // Test 3: Las mensualidades (cuando existen) son todas iguales
    const mPays = schedule
      .filter((r) => r.type === "monthly")
      .map((r) => r.amount);
    const ok3 = mPays.length <= 1 || mPays.every((v) => v === mPays[0]);

    // Test 4: Si hay redondeo, todas las mensualidades deben ser múltiplo de roundingMultiple
    const ok4 =
      roundingMultiple === 0 ||
      schedule
        .filter((r) => r.type === "monthly")
        .every((r) => r.amount % roundingMultiple === 0);

    // Test 5: El precio/m² debe provenir del selector de opciones
    const ok5 = pricePerM2Options.includes(pricePerM2);

    // Test 6: Precio full debe ser área * 365.000
    const ok6 = fullPrice === area * BASE_PRICE_PER_M2;

    // Test 7: Descuento = Precio full - Precio negociado (>= 0)
    const ok7 =
      Math.abs(discountAmount - Math.max(0, fullPrice - area * pricePerM2)) <=
      1;

    console.group("Manamelí – AutoTests");
    console.log(
      "Precio neto:",
      netPrice,
      "; Total partidas:",
      sum,
      "->",
      ok1 ? "OK" : "FALLA",
      " | Redondeo:",
      roundingMultiple
    );
    console.log("Sin mensualidad en meses con extra:", ok2 ? "OK" : "FALLA");
    console.log("Mensualidades iguales:", ok3 ? "OK" : "FALLA");
    console.log("Mensualidades múltiplo del redondeo:", ok4 ? "OK" : "FALLA");
    console.log("Precio/m² válido según selector:", ok5 ? "OK" : "FALLA");
    console.log("Precio full = área * 365k:", ok6 ? "OK" : "FALLA");
    console.log("Descuento = full - negociado:", ok7 ? "OK" : "FALLA");
    console.groupEnd();
  }, [
    netPrice,
    totals,
    orderedExtras,
    schedule,
    roundingMultiple,
    pricePerM2,
    pricePerM2Options,
    area,
    fullPrice,
    discountAmount,
  ]);

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-800">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold">
                Manamelí · Calculadora de Plan de Pagos (Prototipo)
              </h1>
              <p className="text-sm md:text-base text-slate-600 mt-1">
                Ajusta los valores y revisa tu plan de pagos en tiempo real.
                *Prototipo interno para pruebas*.
              </p>
            </div>
            {canInstall && (
              <button
                onClick={promptInstall}
                className="rounded-xl px-4 py-2 bg-emerald-600 text-white hover:bg-emerald-700 shadow"
              >
                Instalar app
              </button>
            )}
          </div>

          {/* Encabezado de cotización */}
          <div className="mt-4 bg-white rounded-2xl shadow p-4">
            <h2 className="text-lg font-semibold mb-3">
              Encabezado de cotización
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <Field label="Fecha de cotización">
                <input
                  type="date"
                  value={quoteDate}
                  onChange={(e) => setQuoteDate(e.target.value)}
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                />
              </Field>
              <Field label="Nombre completo del cliente">
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Nombre y apellidos"
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                />
              </Field>
              <Field label="Teléfono del cliente">
                <input
                  type="tel"
                  value={clientPhone}
                  onChange={(e) => setClientPhone(e.target.value)}
                  placeholder="300 000 0000"
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                />
              </Field>
              <Field label="Correo electrónico del cliente">
                <input
                  type="email"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  placeholder="cliente@correo.com"
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                />
              </Field>
            </div>
          </div>
        </header>

        {/* Panel de entradas */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <section className="bg-white rounded-2xl shadow p-4 lg:col-span-2">
            <h2 className="text-lg font-semibold mb-3">
              Datos del lote y reglas comerciales
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Área (m²)">
                <NumberInput value={area} onChange={setArea} min={1} step={1} />
              </Field>
              <Field label="Precio por m² (COP)">
                {/* Selector discreto desde 365.000 bajando de 5.000 en 5.000 hasta 280.000 */}
                <select
                  value={pricePerM2}
                  onChange={(e) => setPricePerM2(Number(e.target.value))}
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                >
                  {pricePerM2Options.map((v) => (
                    <option key={v} value={v}>
                      {currency(v)} / m²
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Número de lote">
                <input
                  type="text"
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value)}
                  placeholder="N° Parcela"
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                />
              </Field>
            </div>

            <div className="border-t my-4" />

            <h2 className="text-lg font-semibold mb-3">Estructura del plan</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Cuota inicial (COP)">
                <NumberInput
                  value={initialPayment}
                  onChange={setInitialPayment}
                  min={0}
                  step={500000}
                />
              </Field>
              <Field label="Meses de financiación">
                <NumberInput
                  value={months}
                  onChange={setMonths}
                  min={1}
                  max={240}
                  step={1}
                />
              </Field>
              <Field label="Última cuota (balloon) %">
                <NumberInput
                  value={balloonPct}
                  onChange={setBalloonPct}
                  min={0}
                  max={90}
                  step={1}
                />
              </Field>
              <Field label="Inicio del plan (mes)" className="">
                <MonthInput value={startMonth} onChange={setStartMonth} />
              </Field>
              <Field label="Redondeo mensual a múltiplos de">
                <select
                  value={roundingMultiple}
                  onChange={(e) => setRoundingMultiple(Number(e.target.value))}
                  className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
                >
                  <option value={0}>Sin redondeo</option>
                  <option value={10000}>$10.000</option>
                  <option value={50000}>$50.000</option>
                </select>
              </Field>
            </div>

            <div className="border-t my-4" />

            <h2 className="text-lg font-semibold mb-3">
              Cuotas extraordinarias
            </h2>
            <div className="space-y-2">
              {extras.map((ex) => (
                <div
                  key={ex.id}
                  className="flex items-end gap-2 bg-slate-50 border rounded-xl p-3"
                >
                  <Field label="Mes (1..N)" className="flex-1">
                    <NumberInput
                      value={ex.month}
                      onChange={(v) => updateExtra(ex.id, { month: v })}
                      min={1}
                      max={months}
                      step={1}
                    />
                  </Field>
                  <Field label="Valor (COP)" className="flex-1">
                    <NumberInput
                      value={ex.amount}
                      onChange={(v) => updateExtra(ex.id, { amount: v })}
                      min={0}
                      step={500000}
                    />
                  </Field>
                  <button
                    onClick={() => removeExtra(ex.id)}
                    className="px-3 py-2 rounded-xl border bg-white hover:bg-slate-100 transition"
                  >
                    Quitar
                  </button>
                </div>
              ))}
              <button
                onClick={addExtra}
                className="px-4 py-2 rounded-xl border bg-white hover:bg-slate-100 transition"
              >
                + Agregar extraordinaria
              </button>
            </div>
          </section>

          {/* Resumen */}
          <aside className="bg-white rounded-2xl shadow p-4">
            <h2 className="text-lg font-semibold mb-3">Resumen</h2>
            <ul className="space-y-1 text-sm">
              <li className="flex justify-between">
                <span>Precio full:</span>
                <strong>{currency(fullPrice)}</strong>
              </li>
              <li className="flex justify-between">
                <span>Descuento:</span>
                <strong>- {currency(discountAmount)}</strong>
              </li>
              <li className="flex justify-between border-b pb-1">
                <span>Precio neto:</span>
                <strong>{currency(netPrice)}</strong>
              </li>
              <li className="flex justify-between mt-1">
                <span>Cuota inicial:</span>
                <strong>{currency(cappedInitial)}</strong>
              </li>
              <li className="flex justify-between">
                <span>Última cuota (balloon) {balloonPct}%:</span>
                <strong>{currency(totals.balloon)}</strong>
              </li>
              <li className="flex justify-between">
                <span>Total extras:</span>
                <strong>{currency(totals.extrasTotal)}</strong>
              </li>
              <li className="flex justify-between border-t pt-1">
                <span>Total mensualidades:</span>
                <strong>{currency(totals.monthlyTotal)}</strong>
              </li>
              <li className="flex justify-between text-base mt-2">
                <span>Total a pagar:</span>
                <strong>{currency(totals.grand)}</strong>
              </li>
            </ul>

            <div className="mt-4 space-y-2">
              <a
                href={csvHref}
                download={`plan_manameli_${Date.now()}.csv`}
                className="w-full inline-block text-center px-4 py-2 rounded-xl border bg-white hover:bg-slate-100"
              >
                Descargar CSV
              </a>
              <WhatsappShare
                area={area}
                pricePerM2={pricePerM2}
                netPrice={netPrice}
                initial={cappedInitial}
                months={months}
                balloon={totals.balloon}
              />
            </div>
          </aside>
        </div>

        {/* Calendario */}
        <section className="bg-white rounded-2xl shadow p-4 mt-4">
          <h2 className="text-lg font-semibold mb-3">Calendario de pagos</h2>
          <div className="overflow-auto border rounded-xl">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="text-left p-2">Mes</th>
                  <th className="text-left p-2">Fecha</th>
                  <th className="text-left p-2">Concepto</th>
                  <th className="text-left p-2">Valor</th>
                </tr>
              </thead>
              <tbody>
                {scheduleWithDates.map((row, idx) => (
                  <tr
                    key={idx}
                    className={
                      row.type === "extra"
                        ? "bg-green-50"
                        : row.type === "balloon"
                        ? "bg-amber-50"
                        : idx % 2
                        ? "bg-white"
                        : "bg-slate-50"
                    }
                  >
                    <td className="p-2">{row.month}</td>
                    <td className="p-2">{row.date}</td>
                    <td className="p-2">{row.label}</td>
                    <td className="p-2 font-medium">{currency(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="text-xs text-slate-500 mt-6">
          <p>
            *Este prototipo no contempla intereses; simula diferidos a valor
            presente con recálculo tras cuotas extraordinarias y una última
            cuota (%). Ajustar reglas según política de Manamelí (topes de
            descuento, validaciones internas, precio mínimo por m², etc.).
          </p>
        </footer>
      </div>
    </div>
  );
}

// =====================
// Componentes menores
// =====================
function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <div className="text-xs font-medium text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(safeNumber(e.target.value))}
      min={min}
      max={max}
      step={step}
      className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
    />
  );
}

function MonthInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <input
      type="month"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
    />
  );
}

function WhatsappShare({
  area,
  pricePerM2,
  netPrice,
  initial,
  months,
  balloon,
}: {
  area: number;
  pricePerM2: number;
  netPrice: number;
  initial: number;
  months: number;
  balloon: number;
}) {
  const text = encodeURIComponent(
    `Hola, estuve simulando mi plan de pagos en Manamelí:\n\nÁrea: ${area} m²\nPrecio m²: ${currency(
      pricePerM2
    )}\nPrecio neto: ${currency(netPrice)}\nCuota inicial: ${currency(
      initial
    )}\nMeses: ${months}\nÚltima cuota (balloon): ${currency(
      balloon
    )}\n\n¿Me ayudas a revisarlo?`
  );
  const href = `https://wa.me/?text=${text}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="w-full inline-block text-center px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
    >
      Compartir por WhatsApp
    </a>
  );
}

function safeNumber(v: unknown) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
