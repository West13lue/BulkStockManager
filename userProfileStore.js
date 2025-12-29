// userProfileStore.js - Gestion des profils utilisateurs par shop
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

function sanitizeShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  if (!s) return "default";
  return s.replace(/[^a-z0-9._-]/g, "_");
}

function getProfilesPath(shopId) {
  const dir = path.join(DATA_DIR, sanitizeShop(shopId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "user-profiles.json");
}

/**
 * Charger les profils d'un shop
 */
function loadProfiles(shopId) {
  const filePath = getProfilesPath(shopId);
  
  if (!fs.existsSync(filePath)) {
    // Créer le profil Admin par défaut
    const defaultData = {
      profiles: [
        {
          id: "admin",
          name: "Admin",
          role: "admin",
          color: "#6366f1",
          createdAt: new Date().toISOString(),
          isDefault: true
        }
      ],
      activeProfileId: "admin",
      settings: {
        requireProfileSelection: true,
        showProfileInMovements: true
      }
    };
    saveProfiles(shopId, defaultData);
    return defaultData;
  }
  
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error("[UserProfiles] Error loading:", e.message);
    return { profiles: [], activeProfileId: null, settings: {} };
  }
}

/**
 * Sauvegarder les profils
 */
function saveProfiles(shopId, data) {
  const filePath = getProfilesPath(shopId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Récupérer tous les profils
 */
function getProfiles(shopId) {
  const data = loadProfiles(shopId);
  return data.profiles || [];
}

/**
 * Récupérer un profil par ID
 */
function getProfile(shopId, profileId) {
  const profiles = getProfiles(shopId);
  return profiles.find(p => p.id === profileId) || null;
}

/**
 * Créer un nouveau profil
 */
function createProfile(shopId, profileData) {
  const data = loadProfiles(shopId);
  
  // Générer un ID unique
  const id = "user_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  
  const newProfile = {
    id,
    name: profileData.name || "Utilisateur",
    role: profileData.role || "user",
    color: profileData.color || getRandomColor(),
    avatar: profileData.avatar || null,
    createdAt: new Date().toISOString(),
    isDefault: false
  };
  
  data.profiles.push(newProfile);
  saveProfiles(shopId, data);
  
  return newProfile;
}

/**
 * Mettre à jour un profil
 */
function updateProfile(shopId, profileId, updates) {
  const data = loadProfiles(shopId);
  const index = data.profiles.findIndex(p => p.id === profileId);
  
  if (index === -1) return null;
  
  // Ne pas permettre de modifier certains champs du profil admin par défaut
  if (data.profiles[index].isDefault && data.profiles[index].id === "admin") {
    delete updates.id;
    delete updates.isDefault;
  }
  
  data.profiles[index] = {
    ...data.profiles[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };
  
  saveProfiles(shopId, data);
  return data.profiles[index];
}

/**
 * Supprimer un profil
 */
function deleteProfile(shopId, profileId) {
  const data = loadProfiles(shopId);
  
  // Ne pas supprimer le profil admin par défaut
  const profile = data.profiles.find(p => p.id === profileId);
  if (profile && profile.isDefault) {
    return { success: false, error: "Cannot delete default profile" };
  }
  
  const before = data.profiles.length;
  data.profiles = data.profiles.filter(p => p.id !== profileId);
  
  // Si le profil actif est supprimé, revenir à admin
  if (data.activeProfileId === profileId) {
    data.activeProfileId = "admin";
  }
  
  saveProfiles(shopId, data);
  return { success: data.profiles.length < before };
}

/**
 * Définir le profil actif
 */
function setActiveProfile(shopId, profileId) {
  const data = loadProfiles(shopId);
  
  // Vérifier que le profil existe
  const profile = data.profiles.find(p => p.id === profileId);
  if (!profile) {
    return { success: false, error: "Profile not found" };
  }
  
  data.activeProfileId = profileId;
  saveProfiles(shopId, data);
  
  return { success: true, profile };
}

/**
 * Récupérer le profil actif
 */
function getActiveProfile(shopId) {
  const data = loadProfiles(shopId);
  const activeId = data.activeProfileId || "admin";
  return data.profiles.find(p => p.id === activeId) || data.profiles[0] || null;
}

/**
 * Mettre à jour les paramètres
 */
function updateSettings(shopId, settings) {
  const data = loadProfiles(shopId);
  data.settings = { ...data.settings, ...settings };
  saveProfiles(shopId, data);
  return data.settings;
}

/**
 * Couleurs aléatoires pour les profils
 */
function getRandomColor() {
  const colors = [
    "#6366f1", // Indigo
    "#8b5cf6", // Violet
    "#ec4899", // Pink
    "#f43f5e", // Rose
    "#ef4444", // Red
    "#f97316", // Orange
    "#eab308", // Yellow
    "#22c55e", // Green
    "#14b8a6", // Teal
    "#06b6d4", // Cyan
    "#3b82f6", // Blue
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

/**
 * Obtenir les initiales d'un nom
 */
function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

module.exports = {
  loadProfiles,
  saveProfiles,
  getProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  setActiveProfile,
  getActiveProfile,
  updateSettings,
  getInitials
};
