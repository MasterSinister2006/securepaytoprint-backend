
// backend/server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
global.machineEnabled = true;


const upload = require("./uploadHandler");
const db = require("./database");
const { addToQueue } = require("./printQueue");

const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const MAX_USER_PAGES = 100;

// =================================================
// SESSION STORAGE (TEMPORARY - later move to DB)
// =================================================
global.sessions.push({
  sessionId,
  fileName: req.file.originalname,
  pages,
  createdAt: Date.now()
});

// Turn machine ON/OFF
app.post("/admin/machine-toggle", (req, res) => {
  const { enabled } = req.body;
  global.machineEnabled = enabled;
  res.json({
    success: true,
    status: enabled ? "ENABLED" : "DISABLED"
  });
});

// Get machine status
app.get("/machine/status", (req, res) => {
  res.json({
    enabled: global.machineEnabled
  });
});

// =================================================
// CREATE SESSION (UPLOAD + PAGE COUNT)
// =================================================
app.post("/create-session", upload.single("file"), async (req, res) => {
  try {
    if (!global.machineEnabled) {
    return res.status(403).json({
    error: "Machine is under maintenance. Please try later."
    });
    }
    if (global.printerBusy) {
    return res.status(400).json({ error: "Printer is currently busy. Please wait." });
    }

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let pages = 0;

    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      fs.unlinkSync(filePath);
      return res.json({ pages: 0, sessionId: null });
    }

    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));
      pages = data.numpages || 0;
    } else if ([".jpg", ".jpeg", ".png"].includes(ext)) {
      pages = 1;
    } else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      const words = result.value.trim().split(/\s+/).length;
      pages = words === 0 ? 0 : Math.ceil(words / 350);
    } else if (ext === ".xlsx") {
      const workbook = XLSX.readFile(filePath);
      pages = workbook.SheetNames.length;
    } else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "Unsupported file type" });
    }

    const sessionId = Math.random().toString(36).substring(2, 8).toUpperCase();

    global.sessions[sessionId] = {
      sessionId,
      filePath,
      pages,
      paymentStatus: "PENDING",
      printStatus: "WAITING",
      createdAt: new Date()
    };

    console.log("New session created:", sessionId);

    res.json({ sessionId, pages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// =================================================
// FETCH SESSION
// =================================================
app.get("/admin/current-session", (req, res) => {
  if (global.sessions.length === 0) return res.json(null);
  res.json(global.sessions[global.sessions.length - 1]);
});

app.get("/session/:id", (req, res) => {
  const session = global.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// =================================================
// DEMO PAYMENT CONFIRMATION (Machine calls this)
// =================================================
app.post("/confirm-payment", (req, res) => {
  const { sessionId, amount } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  // REAL PAYMENT API SHOULD BE HERE:
  /*
    1. Verify payment using Razorpay/Stripe/UPI callback
    2. Match amount
    3. Confirm transaction ID
  */

  // DEMO ONLY:
  session.paymentStatus = "PAID";
  console.log(`💰 Payment received for session ${sessionId}, Amount: ₹${amount}`);

  res.json({ success: true });
});

// =================================================
// START PRINTING (Called after payment)
// =================================================
app.post("/start-print", (req, res) => {
  const { sessionId } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  session.printStatus = "PRINTING";

  console.log(`🖨 Printing started for session ${sessionId}`);

  // REAL PRINTER API SHOULD BE HERE:
  /*
    send file to printer driver
    wait for printer ACK
  */

  res.json({ success: true, pages: session.pages });
});


// =================================================
// FINISH PRINTING
// =================================================
app.post("/finish-print", (req, res) => {
  const { sessionId } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  session.printStatus = "DONE";

  // DELETE FILE AFTER PRINTING (SECURITY)
  if (fs.existsSync(session.filePath)) fs.unlinkSync(session.filePath);

  console.log(`✅ Printing completed for session ${sessionId}`);

  res.json({ success: true });
});

// =================================================
// ADMIN – VIEW ALL SESSIONS (Payment + Print Status)
// =================================================
app.get("/admin/sessions", (req, res) => {
  res.json(Object.values(global.sessions));
});

// =================================================
// SERVER START
// =================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("======================================");
  console.log(`Server running on port ${PORT}`);
  console.log("Payment + Printing Machine Logic Active");
  console.log("======================================");
});

// Auto reset after 5 minutes if no action
setInterval(() => {
  if (global.sessions && global.sessions.length > 0) {
    const last = global.sessions[global.sessions.length - 1];
    const now = Date.now();

    if (!last.createdAt) last.createdAt = now;

    if (now - last.createdAt > 5 * 60 * 1000) {
      global.sessions = [];
      console.log("Session auto-cleared due to inactivity");
    }
  }
}, 30000);

// Clear current session (machine reset)
app.post("/reset-session", (req, res) => {
  global.sessions = [];
  res.json({ success: true });
  app.post("/admin/reset-machine", (req, res) => {
  global.sessions = [];
  global.printerBusy = false;
  res.json({ success: true, message: "Machine reset by admin" });
});

});