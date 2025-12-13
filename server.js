const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");

const {
  listCategories,
  createCategory,
  deleteCategory,
} = require("./catalogStore");

const { addMovement } = require("./movementStore");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// MIDDLEWARES
// =====================
app.use(cors());
app.use(bodyParser.json());

// =====================
// API - CATEGORIES
// =====================
app.get("/api/categories", (req, res) => {
  try {
    res.json(listCategories());
  } catch (e) {
    console.error("GET categories error:", e);
    res.status(500).json({ error: "Erreur serveur catégories" });
  }
});

app.post("/api/categories", (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Nom requis" });
    }

    const category = createCategory(name);

    // mouvement NON bloquant
    try {
      addMovement({
        type: "CATEGORY_CREATE",
        label: name,
      });
    } catch (e) {
      console.warn("Movement ignored:", e.message);
    }

    res.json(category);
  } catch (e) {
    console.error("POST category error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/categories/:id", (req, res) => {
  try {
    const ok = deleteCategory(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: "Catégorie introuvable" });
    }

    try {
      addMovement({
        type: "CATEGORY_DELETE",
        id: req.params.id,
      });
    } catch {}

    res.json({ success: true });
  } catch (e) {
    console.error("DELETE category error:", e);
    res.status(500).json({ error: e.message });
  }
});

// =====================
// FRONTEND (IMPORTANT)
// =====================
app.use(express.static(path.join(__dirname)));

// ⚠️ FIX ICI : plus de "*"
app.get("/*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// =====================
app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
