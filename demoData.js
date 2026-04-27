/* demoData.js — Realistic sample data for Explore/Demo mode */

import { uid } from "./utils.js";

const now = Date.now();
const day = 86400000;

export const DEMO_DATA = {
  jobs: [
    {
      id: "demo_job_1",
      name: "Attic Insulation — Johnson Residence",
      client: "demo_client_1",
      clientName: "Robert Johnson",
      status: "active",
      date: now - 2 * day,
      address: "1420 Maple Street, Austin, TX 78701",
      description: "Full attic blown-in insulation upgrade to R-49",
      costs: [
        { id: uid(), name: "Blown-in Fiberglass", qty: 45, unitCost: 45, total: 2025 },
        { id: uid(), name: "Labor", qty: 8, unitCost: 65, total: 520 },
      ],
      value:3800,
      tags: ["insulation", "residential"],
      priority: "high",
      paymentStatus: "Unpaid",
      notes: "Access through garage side door. Dog on premises.",
    },
    {
      id: "demo_job_2",
      name: "Crawl Space Encapsulation — Martinez",
      client: "demo_client_2",
      clientName: "Maria Martinez",
      status: "completed",
      date: now - 10 * day,
      address: "892 Oak Avenue, Dallas, TX 75201",
      description: "Full crawl space vapor barrier and encapsulation",
      costs: [
        { id: uid(), name: "Vapor Barrier Material", qty: 2, unitCost: 480, total: 960 },
        { id: uid(), name: "Labor", qty: 12, unitCost: 65, total: 780 },
      ],
      value:2600,
      tags: ["encapsulation"],
      priority: "normal",
      paymentStatus: "Paid",
    },
    {
      id: "demo_job_3",
      name: "Spray Foam — New Build — Thompson",
      client: "demo_client_3",
      clientName: "James Thompson",
      status: "quoted",
      date: now + 3 * day,
      address: "3301 Lakewood Dr, Houston, TX 77001",
      description: "Open-cell spray foam for 2,400 sqft new construction",
      costs: [
        { id: uid(), name: "Spray Foam Material", qty: 1, unitCost: 3200, total: 3200 },
        { id: uid(), name: "Equipment rental", qty: 1, unitCost: 400, total: 400 },
        { id: uid(), name: "Labor", qty: 16, unitCost: 65, total: 1040 },
      ],
      value:6800,
      tags: ["spray-foam", "new-construction"],
      priority: "high",
      paymentStatus: "Unpaid",
    },
    {
      id: "demo_job_4",
      name: "Roof Deck Insulation — City Hall Annex",
      client: "demo_client_4",
      clientName: "City of Austin",
      status: "invoiced",
      date: now - 20 * day,
      address: "124 W 8th St, Austin, TX 78701",
      description: "Commercial roof deck rigid board insulation",
      costs: [
        { id: uid(), name: "Rigid Board R-30", qty: 80, unitCost: 38, total: 3040 },
        { id: uid(), name: "Labor", qty: 24, unitCost: 65, total: 1560 },
        { id: uid(), name: "Lift rental", qty: 1, unitCost: 650, total: 650 },
      ],
      value:8200,
      tags: ["commercial", "roof"],
      priority: "normal",
      paymentStatus: "Invoiced",
    },
    {
      id: "demo_job_5",
      name: "Insulation Removal & Replace — Williams",
      client: "demo_client_1",
      clientName: "Robert Johnson",
      status: "draft",
      date: now + 7 * day,
      address: "1420 Maple Street, Austin, TX 78701",
      description: "Remove old damaged insulation, replace with R-38",
      costs: [
        { id: uid(), name: "Removal labor", qty: 6, unitCost: 65, total: 390 },
        { id: uid(), name: "New insulation R-38", qty: 35, unitCost: 45, total: 1575 },
        { id: uid(), name: "Disposal fee", qty: 1, unitCost: 180, total: 180 },
      ],
      value:3200,
      tags: ["removal", "residential"],
      priority: "low",
      paymentStatus: "Unpaid",
    },
  ],

  clients: [
    { id: "demo_client_1", name: "Robert Johnson", email: "robert.johnson@email.com", phone: "(512) 555-0142", address: "1420 Maple Street, Austin, TX 78701", notes: "Repeat customer — 3 jobs this year" },
    { id: "demo_client_2", name: "Maria Martinez", email: "m.martinez@gmail.com", phone: "(214) 555-0278", address: "892 Oak Avenue, Dallas, TX 75201", notes: "" },
    { id: "demo_client_3", name: "James Thompson", email: "james.t@thompsonbuilds.com", phone: "(713) 555-0391", address: "3301 Lakewood Dr, Houston, TX 77001", notes: "Builder — potential commercial contract" },
    { id: "demo_client_4", name: "City of Austin", email: "procurement@austintx.gov", phone: "(512) 555-0100", address: "124 W 8th St, Austin, TX 78701", notes: "Government account — Net 60 payment terms" },
  ],

  crew: [
    { id: "demo_crew_1", name: "Carlos Rivera", role: "Lead Installer", phone: "(512) 555-0201", hourlyRate: 28, status: "active", certifications: "OSHA 10, BPI Certified" },
    { id: "demo_crew_2", name: "Mike Davis", role: "Installer", phone: "(512) 555-0334", hourlyRate: 22, status: "active", certifications: "OSHA 10" },
    { id: "demo_crew_3", name: "Tony Reyes", role: "Helper", phone: "(512) 555-0445", hourlyRate: 18, status: "active", certifications: "" },
  ],

  timeLogs: [
    { id: "demo_tl_1", jobId: "demo_job_1", crewId: "demo_crew_1", crewName: "Carlos Rivera", clockIn: now - 2*day + 8*3600000, clockOut: now - 2*day + 16*3600000, duration: 8*3600000 },
    { id: "demo_tl_2", jobId: "demo_job_1", crewId: "demo_crew_2", crewName: "Mike Davis", clockIn: now - 2*day + 8*3600000, clockOut: now - 2*day + 15*3600000, duration: 7*3600000 },
    { id: "demo_tl_3", jobId: "demo_job_2", crewId: "demo_crew_1", crewName: "Carlos Rivera", clockIn: now - 10*day + 7*3600000, clockOut: now - 10*day + 17*3600000, duration: 10*3600000 },
  ],

  inventory: [
    { id: "demo_inv_1", name: "Blown-in Fiberglass Bags", category: "insulation", quantity: 120, unit: "bags", unitCost: 45, supplier: "Owens Corning", minStock: 30 },
    { id: "demo_inv_2", name: "Vapor Barrier 20mil", category: "encapsulation", quantity: 8, unit: "rolls", unitCost: 240, supplier: "TerraShield", minStock: 3 },
    { id: "demo_inv_3", name: "Spray Foam Kit — 200 sqft", category: "spray-foam", quantity: 14, unit: "kits", unitCost: 185, supplier: "Foam-It-Green", minStock: 5 },
    { id: "demo_inv_4", name: "Rigid Board R-30 4x8", category: "rigid-board", quantity: 45, unit: "sheets", unitCost: 38, supplier: "Johns Manville", minStock: 20 },
  ],

  estimates: [
    { id: "demo_est_1", clientId: "demo_client_3", clientName: "James Thompson", title: "Spray Foam — New Build", status: "sent", total: 6800, date: now - 3*day, validUntil: now + 27*day },
  ],

  templates: [],
  mileageLogs: [],
  equipment: [],
  pricebook: [],
  materials: [],
};
