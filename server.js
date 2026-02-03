// backend/server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const upload = require("./uploadHandler");
const db = require("./database");
const { addToQueue } = require("./printQueue");

const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

const app = express();

app.get("/", (req, res) => {
  res.status(200).send("SecurePayToPrint backend is running ✅");
});

// ===================== GLOBAL STATE =====================
global.machineEnabled = true;
global.printerBusy = false;

// Store sessions in both: array (latest session) + map (fast lookup)
global.sessions = [];
global.sessionsById = {};

// ===================== MIDDLEWARE =====================
app.use(
  cors({
    origin: [
      // ✅ Your Netlify domain
      "https://securepaytoprint-frontend.netlify.app",
      // Optional local dev (won't affect online)
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// Optional: serve your frontend if you ever open backend directly
app.use(express.static(path.join(__dirname, "../frontend")));

// ===================== CONFIG =====================
const MAX_USER_PAGES = 150;
const SESSION_EXPIRE_MS = 5 * 60 * 1000; // 5 min

// ===================== HELPERS =====================
function generateSessionId() {
  // Longer + uppercase to look clean
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function getLastSession() {
  if (!global.sessions || global.sessions.length === 0) return null;
  return global.sessions[global.sessions.length - 1];
}

function safeDeleteFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

function clearAllSessions() {
  // Delete uploaded files for privacy
  for (const s of global.sessions) safeDeleteFile(s?.filePath);

  global.sessions = [];
  global.sessionsById = {};
}

async function countPages(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  const stats = fs.statSync(filePath);
  if (!stats || stats.size === 0) return 0;

  // PDF
  if (ext === ".pdf") {
    const data = await pdf(fs.readFileSync(filePath));
    return data.numpages || 0;
  }

  // Images -> 1 page
  if ([".jpg", ".jpeg", ".png"].includes(ext)) return 1;

  // DOCX -> rough estimate
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    const text = (result.value || "").trim();
    if (!text) return 0;
    const words = text.split(/\s+/).length;
    return Math.ceil(words / 350); // 350 words ~ 1 page
  }

  // XLSX -> number of sheets (demo)
  if (ext === ".xlsx") {
    const workbook = XLSX.readFile(filePath);
    return workbook.SheetNames.length;
  }

  return -1; // unsupported
}

// ===================== HEALTH CHECK (useful on Render) =====================
app.get("/", (req, res) => {
  res.send("SecurePayToPrint backend is running ✅");
});

// ===================== MACHINE STATUS =====================
app.get("/machine/status", (req, res) => {
  res.json({ enabled: !!global.machineEnabled });
});

// ===================== ADMIN STATUS (admin.js expects this) =====================
app.get("/admin/status", (req, res) => {
  res.json({
    printerBusy: !!global.printerBusy,
    machineEnabled: !!global.machineEnabled,
    sessions: global.sessions.length,
  });
});

// ===================== ADMIN: MACHINE TOGGLE =====================
app.post("/admin/machine-toggle", (req, res) => {
  const { enabled } = req.body;
  global.machineEnabled = !!enabled;

  res.json({
    success: true,
    status: global.machineEnabled ? "ENABLED" : "DISABLED",
  });
});

// ===================== CREATE SESSION (UPLOAD + PAGE COUNT) =====================
app.post("/create-session", upload.single("file"), async (req, res) => {
  try {
    if (!global.machineEnabled) {
      return res.status(403).json({
        error: "Machine is under maintenance. Please try later.",
      });
    }

    if (global.printerBusy) {
      return res.status(400).json({
        error: "Printer is currently busy. Please wait.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;
    const pages = await countPages(filePath, req.file.originalname);

    // unsupported type
    if (pages === -1) {
      safeDeleteFile(filePath);
      return res.status(400).json({ error: "Unsupported file type" });
    }

    // empty
    if (pages <= 0) {
      safeDeleteFile(filePath);
      return res.json({ sessionId: null, pages: 0 });
    }

    // too many pages
    if (pages > MAX_USER_PAGES) {
      safeDeleteFile(filePath);
      return res.status(400).json({
        error: `Maximum ${MAX_USER_PAGES} pages allowed per print job.`,
      });
    }

    const sessionId = generateSessionId();

    const session = {
      sessionId,
      fileName: req.file.originalname,
      filePath,
      pages,
      paymentStatus: "PENDING",
      printStatus: "WAITING",
      createdAt: Date.now(),
    };

    global.sessions.push(session);
    global.sessionsById[sessionId] = session;

    console.log("✅ Session created:", sessionId, "| Pages:", pages);

    res.json({ sessionId, pages });
  } catch (err) {
    console.error("❌ create-session error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===================== GET SESSION =====================
app.get("/admin/current-session", (req, res) => {
  const last = getLastSession();
  if (!last) return res.json(null);
  res.json(last);
});

app.get("/admin/sessions", (req, res) => {
  res.json(global.sessions);
});

app.get("/session/:id", (req, res) => {
  const session = global.sessionsById[req.params.id];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// ===================== DEMO PAYMENT CONFIRM =====================
// (You can connect real gateway later. For now, machine can mark it paid.)
app.post("/confirm-payment", (req, res) => {
  const { sessionId, amount } = req.body;
  const session = global.sessionsById[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  session.paymentStatus = "PAID";
  session.amount = Number(amount) || 0;

  console.log(`💰 Payment confirmed: ${sessionId} | Amount: ₹${session.amount}`);
  res.json({ success: true });
});

// ===================== START PRINT =====================
app.post("/start-print", (req, res) => {
  const { sessionId, copies = 1, printType = "bw" } = req.body;
  const session = global.sessionsById[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  if (!global.machineEnabled) {
    return res.status(403).json({ error: "Machine is under maintenance." });
  }

  if (global.printerBusy) {
    return res.status(400).json({ error: "Printer is busy. Please wait." });
  }

  if (session.paymentStatus !== "PAID") {
    return res.status(400).json({ error: "Payment not confirmed yet." });
  }

  global.printerBusy = true;
  session.printStatus = "PRINTING";
  session.copies = Math.max(1, Number(copies) || 1);
  session.printType = printType === "color" ? "color" : "bw";

  console.log(`🖨 Print started: ${sessionId} | copies=${session.copies}`);

  // Add to your simulated queue
  addToQueue({
    token: sessionId,
    filePath: session.filePath,
  });

  // Demo: auto-finish after a time based on pages
  const seconds = Math.max(10, Math.min(90, session.pages * session.copies));
  setTimeout(() => {
    const s = global.sessionsById[sessionId];
    if (!s) {
      global.printerBusy = false;
      return;
    }

    s.printStatus = "DONE";
    global.printerBusy = false;

    // Optional DB log (if your DB tables exist)
    try {
      db.run(
        `INSERT INTO PrintLogs(token, phone, printer_id, pages, print_type, amount, time)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          s.phone || "",
          s.printer_id || "SOS",
          s.pages,
          s.printType || "bw",
          s.amount || 0,
          new Date().toISOString(),
        ]
      );
    } catch (e) {}

    console.log(`✅ Print finished: ${sessionId}`);
  }, seconds * 1000);

  res.json({ success: true, pages: session.pages });
});

// ===================== FINISH PRINT (manual) =====================
app.post("/finish-print", (req, res) => {
  const { sessionId } = req.body;
  const session = global.sessionsById[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  session.printStatus = "DONE";
  global.printerBusy = false;

  // delete file for privacy (optional)
  safeDeleteFile(session.filePath);

  res.json({ success: true });
});

// ===================== RESET SESSION (machine screen uses this) =====================
app.post("/reset-session", (req, res) => {
  clearAllSessions();
  global.printerBusy = false;
  res.json({ success: true });
});

// ===================== ADMIN RESET MACHINE =====================
app.post("/admin/reset-machine", (req, res) => {
  clearAllSessions();
  global.printerBusy = false;
  res.json({ success: true, message: "Machine reset by admin" });
});

// ===================== AUTO CLEANUP EXPIRED SESSIONS =====================
setInterval(() => {
  if (!global.sessions || global.sessions.length === 0) return;

  const now = Date.now();
  const keep = [];
  const newMap = {};

  for (const s of global.sessions) {
    const created = s.createdAt || now;
    const expired = now - created > SESSION_EXPIRE_MS;

    if (expired) {
      safeDeleteFile(s.filePath);
    } else {
      keep.push(s);
      newMap[s.sessionId] = s;
    }
  }

  if (keep.length !== global.sessions.length) {
    global.sessions = keep;
    global.sessionsById = newMap;

    if (global.sessions.length === 0) global.printerBusy = false;

    console.log("🧹 Cleanup done. Active sessions:", global.sessions.length);
  }
}, 30 * 1000);

// ===================== START SERVER =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("======================================");
  console.log(`Server running on port ${PORT}`);
  console.log("Backend live for Netlify origin ✅");
  console.log("======================================");
});
