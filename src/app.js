const express = require("express");
const cors = require("cors");

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Test Route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "Backend is live 🚀" });
});
app.get("/", (req, res) => {
  res.send("Civic Backend Running 🚀");
});
module.exports = app;