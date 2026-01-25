
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "../database/print.db");

const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error("Database connection error:", err);
  } else {
    console.log("Database connected at:", dbPath);
  }
});

/* ------------------ Print Logs ------------------ */
db.run(`
CREATE TABLE IF NOT EXISTS PrintLogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT,
  phone TEXT,
  printer_id TEXT,
  pages INTEGER,
  print_type TEXT,
  amount INTEGER,
  time TEXT
)
`, err => {
  if (err) console.error("PrintLogs table error:", err);
  else console.log("PrintLogs table ready.");
});

/* ---------------- Printer Status ---------------- */
db.run(`
CREATE TABLE IF NOT EXISTS PrinterStatus (
  printer_id TEXT PRIMARY KEY,
  black_ink INTEGER,
  color_ink INTEGER,
  paper INTEGER
)
`, err => {
  if (err) console.error("PrinterStatus table error:", err);
  else console.log("PrinterStatus table ready.");
});

/* -------- Initialize Default Printers -------- */
const printers = ["SOS", "SOT", "ANVI"];

printers.forEach(p => {
  db.run(
    `INSERT OR IGNORE INTO PrinterStatus(printer_id, black_ink, color_ink, paper)
     VALUES (?, 100, 100, 500)`,
    [p],
    err => {
      if (err) console.error(`Init error for printer ${p}:`, err);
      else console.log(`Printer ${p} initialized.`);
    }
  );
});

module.exports = db;
