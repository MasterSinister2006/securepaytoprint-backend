// backend/server.js
// ================================================
// Secure Pay To Print - Backend Server
// ================================================
// OTP REMOVED as per requirement.
// Payment is DEMO for now (real API integration left in comments).
// Session-based vending machine flow is ACTIVE and REAL.
// User uploads file → session created → machine reads session → real pages shown.

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const app = express();
const limiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 50,
    message: "Too many requests. Please slow down."
  });

app.use(limiter);

const upload = require("./uploadHandler");
const db = require("./database");
const { addToQueue } = require("./printQueue");

const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

app.use(cors({
    origin: "*",   // For now allow all. Later restrict to your Netlify domain.
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
  }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const MAX_USER_PAGES = 100;

// In-memory session store (later can move to Redis/DB)
global.sessions = {};

// =================================================
// FUTURE PAYMENT PLACEHOLDER
// =================================================
// TODO (FUTURE):
// app.post("/verify-payment", (req, res) => {
//   Integrate Razorpay / PhonePe / UPI QR verification here
// });
// For now, payment is assumed successful in frontend demo.

// =================================================
// CREATE SESSION (User Upload Entry Point)
// =================================================
app.post("/create-session", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let pages = 0;

    // Empty file check
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      fs.unlinkSync(filePath);
      return res.json({ pages: 0, sessionId: null });
    }

    // Page detection logic
    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));
      pages = data.numpages || 0;
    }
    else if ([".jpg", ".jpeg", ".png"].includes(ext)) {
      pages = 1;
    }
    else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      const text = result.value.trim();
      pages = text.length === 0 ? 0 : Math.ceil(text.split(/\s+/).length / 350);
    }
    else if (ext === ".xlsx") {
      const workbook = XLSX.readFile(filePath);
      pages = workbook.SheetNames.length;
    }
    else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "Unsupported file type" });
    }

    const sessionId = crypto.randomBytes(8).toString("hex").toUpperCase();

    // Save session
    global.sessions[sessionId] = {
      sessionId,
      filePath,
      pages,
      status: "UPLOADED",
      createdAt: Date.now()
    };


    console.log("🆕 New Session Created:", sessionId, "| Pages:", pages);

    res.json({
      sessionId,
      pages
    });

  } catch (err) {
    console.error("CREATE SESSION ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =================================================
// FETCH SESSION (Machine reads this to get REAL pages)
// =================================================
app.get("/session/:id", (req, res) => {
  const sessionId = req.params.id;
  if (!global.sessions[sessionId]) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(global.sessions[sessionId]);
});

// =================================================
// TOKEN GENERATOR
// =================================================
function generateToken() {
  return Math.random().toString(16).substring(2, 8).toUpperCase();
}

// =================================================
// PRINT UPLOAD + PRINTER MANAGEMENT (unchanged core)
// =================================================
app.post("/upload", upload.single("file"), (req, res) => {
  const { pages, print_type, amount, isAdmin, force } = req.body;
  const printer_id = req.query.printer || "SOS";

  const token = generateToken();
  const totalPages = Number(pages);
  const admin = isAdmin === "true" || isAdmin === true;

  if (!admin && totalPages > MAX_USER_PAGES) {
    return res.status(400).json({
      error: "Normal users can print only 100 pages at a time."
    });
  }

  db.get(
    "SELECT * FROM PrinterStatus WHERE printer_id = ?",
    [printer_id],
    (err, printer) => {
      if (err || !printer) {
        return res.status(500).json({ error: "Printer not found" });
      }

      const availablePaper = printer.paper;

      if (!admin && availablePaper < totalPages && !force) {
        return res.json({
          warning: true,
          available: availablePaper,
          message: `Only ${availablePaper} pages available. Last ${totalPages - availablePaper} pages will NOT be printed. Continue?`
        });
      }

      const pagesToPrint = admin
        ? totalPages
        : Math.min(totalPages, availablePaper);

      let blackInkUsed = 0;
      let colorInkUsed = 0;

      if (print_type === "bw") {
        blackInkUsed = pagesToPrint * 0.3;
      } else {
        blackInkUsed = pagesToPrint * 0.2;
        colorInkUsed = pagesToPrint * 0.4;
      }

      const newBlackInk = Math.max(0, printer.black_ink - blackInkUsed);
      const newColorInk = Math.max(0, printer.color_ink - colorInkUsed);
      const newPaper = Math.max(0, printer.paper - pagesToPrint);

      db.run(
        `UPDATE PrinterStatus 
         SET black_ink = ?, color_ink = ?, paper = ?
         WHERE printer_id = ?`,
        [newBlackInk, newColorInk, newPaper, printer_id],
        err => {
          if (err) {
            return res.status(500).json({ error: "Failed to update printer status" });
          }

          db.run(
            `INSERT INTO PrintLogs(token, printer_id, pages, print_type, amount, time)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [token, printer_id, pagesToPrint, print_type, amount],
            err => {
              if (err) {
                return res.status(500).json({ error: "Database error" });
              }

              console.log(`\n🖨 Printing on ${printer_id} (Reverse Order):`);
              for (let i = pagesToPrint; i >= 1; i--) {
                console.log(`Printing page ${i}`);
              }

              addToQueue({
                token,
                printer_id,
                filePath: req.file?.path || null
              });

              res.json({
                success: true,
                token,
                printedPages: pagesToPrint,
                remainingPaper: newPaper,
                remainingBlackInk: newBlackInk.toFixed(1),
                remainingColorInk: newColorInk.toFixed(1)
              });
            }
          );
        }
      );
    }
  );
});
  // Auto delete abandoned sessions and uploaded files every 30 minutes
  // SECURITY: Always delete uploaded file after printing
  // fs.unlinkSync(session.filePath);
  // delete global.sessions[sessionId];

  setInterval(() => {
    const now = Date.now();
      for (let id in global.sessions) {
          const session = global.sessions[id];
          if (now - session.createdAt > 30 * 60 * 1000) { // 30 minutes
          if (fs.existsSync(session.filePath)) {
          fs.unlinkSync(session.filePath);
          }
          delete global.sessions[id];
          console.log("🗑 Cleaned expired session:", id);
        }
      }
    }, 30 * 60 * 1000);

// =================================================
// SERVER START
// =================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("======================================");
  console.log(`Server running on port ${PORT}`);
  console.log("======================================");
});
