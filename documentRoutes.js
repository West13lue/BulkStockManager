// documentRoutes.js - routes UI /api/documents* (factures fournisseur en PDF).
// Montees sur le router de server.js APRES requireApiAuth / enforceAuthShopMatch : JWT App Bridge obligatoire,
// boutique = celle du JWT (getShop). Reservees aux plans avec bons de commande (hasPurchaseOrders).
//
// Donnees personnelles : jamais de contenu (ni de nom de fichier) dans les logs ; reponses en Cache-Control: no-store.
//
// Corps de l'upload (POST) : le parser JSON global de /api est limite a 2 Mo ; server.js le saute pour
// POST /api/documents, et cette route a son propre express.json({limit:"15mb"}) - donc lu seulement
// apres authentification (un appel sans JWT est refuse avant d'avoir lu le corps).
//
//   GET    /api/documents?purchaseOrderId=&supplierId=   metadonnees
//   GET    /api/documents/:id/file                       PDF (inline)
//   POST   /api/documents   { purchaseOrderId?, supplierId?, invoiceNumber?, invoiceDate?, filename, contentBase64 }
//   DELETE /api/documents/:id

"use strict";

function registerDocumentRoutes(router, deps) {
  const express = require("express");
  const { getShop, apiError, safeJson, planManager, purchaseOrderStore, supplierStore, documentStore, logEvent } = deps;
  const uploadParser = express.json({ limit: "15mb" });

  // Renvoie la boutique si l'acces est autorise, sinon repond (400/403/500) et renvoie null.
  function access(req, res) {
    const shop = getShop(req);
    if (!shop) {
      apiError(res, 400, "Shop introuvable");
      return null;
    }
    if (planManager && !planManager.hasFeature(shop, "hasPurchaseOrders")) {
      res.status(403).json({ error: "plan_limit", message: "Les factures fournisseur sont reservees au plan Business", upgrade: "business" });
      return null;
    }
    if (!documentStore) {
      apiError(res, 500, "Module documents non disponible");
      return null;
    }
    res.set("Cache-Control", "no-store");
    return shop;
  }

  const fail = (res, e) => {
    if (e instanceof documentStore.DocumentError) return res.status(e.status).json({ error: e.code, message: e.message });
    throw e;
  };

  router.get("/api/documents", (req, res) => {
    safeJson(req, res, () => {
      const shop = access(req, res);
      if (!shop) return;
      const documents = documentStore.listDocuments(shop, {
        purchaseOrderId: req.query.purchaseOrderId ? String(req.query.purchaseOrderId) : undefined,
        supplierId: req.query.supplierId ? String(req.query.supplierId) : undefined,
      });
      res.json({ documents });
    });
  });

  router.get("/api/documents/:id/file", (req, res) => {
    safeJson(req, res, () => {
      const shop = access(req, res);
      if (!shop) return;
      const doc = documentStore.getDocument(shop, req.params.id);
      const file = doc && documentStore.getDocumentFilePath(shop, req.params.id);
      if (!doc || !file) return apiError(res, 404, "Document introuvable");
      const safeName = documentStore.sanitizeFilename(doc.filename);
      const ascii = safeName.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        "Content-Length": String(doc.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      require("fs").createReadStream(file).on("error", () => res.destroy()).pipe(res);
    });
  });

  router.post("/api/documents", uploadParser, (req, res) => {
    safeJson(req, res, () => {
      const shop = access(req, res);
      if (!shop) return;
      try {
        const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
        const buffer = documentStore.decodePdfBase64(body.contentBase64);

        let po = null;
        if (body.purchaseOrderId) {
          if (!purchaseOrderStore) return apiError(res, 500, "Module commandes non disponible");
          po = purchaseOrderStore.getPurchaseOrder(shop, String(body.purchaseOrderId));
          if (!po) return apiError(res, 404, "Commande non trouvee");
        }
        let supplierId = body.supplierId ? String(body.supplierId) : po?.supplierId || null;
        let supplierName = po?.supplierName || null;
        if (supplierId && supplierStore) {
          const sup = supplierStore.getSupplier(shop, supplierId);
          if (!sup) return apiError(res, 404, "Fournisseur non trouve");
          supplierName = sup.name;
        }

        const invoice = po?.invoice || null;
        const { document, deduped } = documentStore.saveDocument(shop, {
          buffer,
          filename: body.filename,
          kind: "invoice",
          supplierId,
          supplierName,
          purchaseOrderId: po ? po.id : null,
          invoiceNumber: body.invoiceNumber || invoice?.number,
          invoiceDate: body.invoiceDate || invoice?.date,
          totals: po
            ? { productsHT: po.subtotal, shippingHT: po.shippingCost, totalHT: po.total, taxTotal: invoice?.taxTotal, totalTTC: invoice?.totalTTC }
            : null,
          createdBy: typeof body.profileName === "string" && body.profileName.trim() ? body.profileName.trim().slice(0, 60) : "Utilisateur",
        });
        if (po) purchaseOrderStore.attachDocument(shop, po.id, document.id);
        logEvent("document_uploaded", { shop, documentId: document.id, size: document.size, deduped, purchaseOrderId: po ? po.id : undefined });
        res.json({ success: true, deduped, document });
      } catch (e) {
        return fail(res, e);
      }
    });
  });

  router.delete("/api/documents/:id", (req, res) => {
    safeJson(req, res, () => {
      const shop = access(req, res);
      if (!shop) return;
      const doc = documentStore.deleteDocument(shop, req.params.id);
      if (!doc) return apiError(res, 404, "Document introuvable");
      if (purchaseOrderStore) {
        try {
          purchaseOrderStore.detachDocumentEverywhere(shop, doc.id);
        } catch (e) {
          logEvent("document_detach_error", { shop, documentId: doc.id, error: e.message }, "warn");
        }
      }
      logEvent("document_deleted", { shop, documentId: doc.id });
      res.json({ success: true });
    });
  });

  // Corps invalide / trop gros (parser de cette route uniquement).
  router.use("/api/documents", (err, req, res, next) => {
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large", message: "Fichier trop volumineux (max 10 Mo)" });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json", message: "JSON invalide" });
    return next(err);
  });
}

module.exports = { registerDocumentRoutes };
