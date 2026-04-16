/* ─── App Config ─────────────────────────────────────────── */
export const APP = {
  dbName: "jobcost_pro_db",
  dbVersion: 7,
  stores: {
    jobs: "jobs",
    timeLogs: "timeLogs",
    templates: "templates",
    clients: "clients",
    crew: "crew",
    inventory: "inventory",
    estimates: "estimates",
    mileageLogs: "mileageLogs",
  },
  lsKey: "jobcost_pro_v2",
};

/* ─── Translations ───────────────────────────────────────── */
export const T = {
  en: {
    Dashboard: "Dashboard", Jobs: "Jobs", Clients: "Clients", Field: "Field",
    Templates: "Templates", Analytics: "Analytics", Settings: "Settings",
    Estimates: "Estimates", Pipeline: "Pipeline", Crew: "Crew", Inventory: "Inventory",
    "New Job": "New Job", "New Template": "New Template", Export: "Export",
    "Search jobs, clients…": "Search jobs, clients…",
    Save: "Save", Cancel: "Cancel", Delete: "Delete", Edit: "Edit",
    Active: "Active", Completed: "Completed", Invoiced: "Invoiced",
    Draft: "Draft", Lead: "Lead", Quoted: "Quoted",
    "Clock In": "Clock In", "Clock Out": "Clock Out", Timer: "Timer",
    "Logged Hours": "Logged Hours", "Total Jobs": "Total Jobs",
    "Total Costs": "Total Costs", "Total Margin": "Total Margin",
    "Hours Logged": "Hours Logged", "Recent Jobs": "Recent Jobs",
    "Time Tracking": "Time Tracking",
  },
  es: {
    Dashboard: "Panel", Jobs: "Trabajos", Clients: "Clientes", Field: "Campo",
    Templates: "Plantillas", Analytics: "Análisis", Settings: "Ajustes",
    Estimates: "Cotizaciones", Pipeline: "Pipeline", Crew: "Equipo", Inventory: "Inventario",
    "New Job": "Nuevo Trabajo", "New Template": "Nueva Plantilla", Export: "Exportar",
    "Search jobs, clients…": "Buscar trabajos, clientes…",
    Save: "Guardar", Cancel: "Cancelar", Delete: "Eliminar", Edit: "Editar",
    Active: "Activo", Completed: "Completado", Invoiced: "Facturado",
    Draft: "Borrador", Lead: "Prospecto", Quoted: "Cotizado",
    "Clock In": "Registrar Entrada", "Clock Out": "Registrar Salida", Timer: "Temporizador",
    "Logged Hours": "Horas Registradas", "Total Jobs": "Total Trabajos",
    "Total Costs": "Costos Totales", "Total Margin": "Margen Total",
    "Hours Logged": "Horas Registradas", "Recent Jobs": "Trabajos Recientes",
    "Time Tracking": "Control de Tiempo",
  },
};
