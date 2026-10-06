import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, addDoc, doc, getDoc, serverTimestamp as firestoreServerTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  update,
  get,
  push,
  serverTimestamp,
  onValue,
  remove,
  query,
  orderByChild,
  startAt,
  endAt,
  equalTo
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDXlfkDKzeBAkXCWSg3G1914XXC1XN2AAg",
  authDomain: "whitequiz-24288.firebaseapp.com",
  projectId: "whitequiz-24288",
  databaseURL: "https://whitequiz-24288-default-rtdb.asia-southeast1.firebasedatabase.app",
  storageBucket: "whitequiz-24288.firebasestorage.app",
  messagingSenderId: "852892167245",
  appId: "1:852892167245:web:43afff0a3390c475bec004"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const rtdb = getDatabase(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

let quiz = [];
let currentIndex = 0;
let audio;

// MULTIPLE CHOICE STATE
let mcIndex = 0;
let mcQuestions = [];
let mcSelected = null;

// GOOGLE AUTH / ACCOUNT SYNC / PWA STATE
let currentUser = null;
let deferredInstallPrompt = null;
let decks = {};
let activeDeckId = null;
let decksLoaded = false;
let stopDeckListener = null;
let legacyMigrationDone = false;
let sharedQuizCache = null;
let profileData = null, chatUsers = {}, activeChatUid = null, stopChatListListener = null, stopMessagesListener = null;

const USER_CACHE_PREFIX = "whitequiz-user-cache-v2-";
const ACTIVE_DECK_PREFIX = "whitequiz-active-deck-v2-";

function isHomePage() {
  return !!document.getElementById("addCardPanel");
}

function userCacheKey(uid) {
  return `${USER_CACHE_PREFIX}${uid}`;
}

function activeDeckKey(uid) {
  return `${ACTIVE_DECK_PREFIX}${uid}`;
}

function normalizeDeck(raw, fallbackName = "General") {
  return {
    name: String(raw?.name || fallbackName).trim() || fallbackName,
    cards: Array.isArray(raw?.cards) ? raw.cards.filter(c => c && c.question && c.answer).map(c => ({
      question: String(c.question),
      answer: String(c.answer)
    })) : [],
    createdAt: raw?.createdAt ?? null,
    updatedAt: raw?.updatedAt ?? null
  };
}

function localCache() {
  if (!currentUser) return;
  try {
    localStorage.setItem(userCacheKey(currentUser.uid), JSON.stringify({ decks, activeDeckId }));
    if (activeDeckId && decks[activeDeckId]) {
      localStorage.setItem("quizData", JSON.stringify(decks[activeDeckId].cards || []));
    }
    localStorage.setItem("activeDeckName", activeDeckId && decks[activeDeckId] ? decks[activeDeckId].name : "");
  } catch (e) {
    console.warn("Local cache save failed:", e);
  }
}

function loadCachedUserData(uid) {
  try {
    const raw = localStorage.getItem(userCacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const cachedDecks = parsed?.decks || {};
    return {
      decks: Object.fromEntries(Object.entries(cachedDecks).map(([id, deck]) => [id, normalizeDeck(deck)])),
      activeDeckId: parsed?.activeDeckId || null
    };
  } catch (e) {
    console.warn("Local cache read failed:", e);
    return null;
  }
}

function clearActiveQuizCache() {
  localStorage.removeItem("quizData");
  localStorage.removeItem("activeDeckName");
}

function setActiveDeckLocal(id) {
  activeDeckId = id || null;
  if (currentUser && activeDeckId) localStorage.setItem(activeDeckKey(currentUser.uid), activeDeckId);
  localCache();
}

function getActiveDeck() {
  return activeDeckId && decks[activeDeckId] ? decks[activeDeckId] : null;
}

function setQuizFromActiveDeck() {
  const active = getActiveDeck();
  quiz = active ? [...active.cards] : [];
  localCache();
  updateAllDeckUI();
  updateStat();
  if (document.getElementById("cardContainer")) showReviewer();
}

function updateStat() {
  const el = document.getElementById("statCount");
  if (el) el.textContent = quiz.length;
  const deckEl = document.getElementById("statDeckCount");
  if (deckEl) deckEl.textContent = Object.keys(decks).length;
}

function getAuthErrorMessage(error) {
  const code = error?.code || "";
  const messages = {
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/popup-blocked": "The browser blocked the Google window. Switching to secure redirect sign-in...",
    "auth/unauthorized-domain": "Add this website domain to Firebase Authentication → Settings → Authorized domains.",
    "auth/cancelled-popup-request": "Only one Google sign-in request can run at a time."
  };
  return messages[code] || error?.message || "Google sign-in failed. Please try again.";
}

function showAuthMessage(message, isError = false) {
  const box = document.getElementById("authMessage");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("error", isError);
  box.classList.remove("hidden");
}

function updateAuthUI(user) {
  const loginModal = document.getElementById("mandatoryAuthModal");
  const addCardPanel = document.getElementById("addCardPanel");
  const authUserBox = document.getElementById("authUserBox");
  const accountStatus = document.getElementById("accountStatus");
  const settingsAccount = document.getElementById("settingsAccount");

  if (loginModal && isHomePage()) loginModal.classList.toggle("hidden", !!user);
  if (addCardPanel) {
    addCardPanel.classList.remove("hidden");
    addCardPanel.classList.toggle("auth-locked-preview", !user);
  }
  if (isHomePage()) document.body.classList.toggle("auth-locked", !user);

  if (authUserBox) {
    if (user) {
      const safeName = escapeHTML(user.displayName || "Google User");
      const safeEmail = escapeHTML(user.email || "");
      authUserBox.innerHTML = `
        <img src="${escapeAttribute(user.photoURL || 'logo.png')}" alt="Google profile" class="auth-avatar">
        <div class="auth-user-copy">
          <strong>${safeName}</strong>
          <span>${safeEmail}</span>
          <small>☁ Auto-synced to this Google account</small>
        </div>
        <button class="auth-signout-btn" type="button" onclick="logoutGoogle()">Sign out</button>
      `;
      authUserBox.classList.remove("hidden");
    } else {
      authUserBox.classList.add("hidden");
      authUserBox.innerHTML = "";
    }
  }

  if (accountStatus) {
    accountStatus.innerHTML = user
      ? `<span class="status-dot online"></span><div><strong>${escapeHTML(user.displayName || "Google account")}</strong><small>${escapeHTML(user.email || "")} • Sync ON</small></div>`
      : `<span class="status-dot"></span><div><strong>Not signed in</strong><small>Google sign-in required for cloud sync</small></div>`;
  }
  if (settingsAccount) {
    settingsAccount.innerHTML = user ? `
      <div class="settings-account-top"><img class="settings-account-avatar" src="${escapeAttribute(user.photoURL || 'logo.png')}" alt=""><div class="settings-account-copy"><strong>${escapeHTML(user.displayName || 'Google User')}</strong><small>${escapeHTML(user.email || '')}</small></div></div>
      <div class="settings-account-actions"><button class="btn-secondary" type="button" onclick="logoutGoogle()">Sign out</button></div>` : `
      <div class="settings-account-top"><div class="settings-account-avatar" style="display:grid;place-items:center;font-size:1.3rem">G</div><div class="settings-account-copy"><strong>Not signed in</strong><small>Sign in to sync and use Chat</small></div></div>
      <div class="settings-account-actions"><button class="btn-primary" type="button" onclick="loginWithGoogle()">Continue with Google</button></div>`;
  }
}

function openMandatoryAuth() {
  const modal = document.getElementById("mandatoryAuthModal");
  if (!modal || currentUser || !isHomePage()) return;
  modal.classList.remove("hidden");
  document.body.classList.add("auth-locked");
}

window.loginWithGoogle = async function () {
  const btn = document.getElementById("googleLoginBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="google-mark">G</span> Connecting to Google...';
  }
  showAuthMessage("Opening Google sign-in…");

  try {
    await signInWithPopup(auth, googleProvider);
    showAuthMessage("Signed in. Loading your decks…");
  } catch (error) {
    console.error(error);
    if (error?.code === "auth/popup-blocked" || error?.code === "auth/operation-not-supported-in-this-environment") {
      try {
        await signInWithRedirect(auth, googleProvider);
        return;
      } catch (redirectError) {
        console.error(redirectError);
        showAuthMessage(getAuthErrorMessage(redirectError), true);
      }
    } else {
      showAuthMessage(getAuthErrorMessage(error), true);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="google-mark">G</span> Continue with Google';
    }
  }
};

window.logoutGoogle = async function () {
  try {
    await signOut(auth);
    showAuthMessage("Signed out. Your saved decks remain safely stored in your Google account.");
  } catch (error) {
    console.error(error);
    showAuthMessage("Could not sign out. Please try again.", true);
  }
};

async function recordLogin(user) {
  try {
    await update(ref(rtdb, `users/${user.uid}`), {
      uid: user.uid,
      name: user.displayName || "Google User",
      email: user.email || "",
      photoURL: user.photoURL || "",
      lastLogin: serverTimestamp()
    });
    await push(ref(rtdb, `loginHistory/${user.uid}`), {
      uid: user.uid,
      name: user.displayName || "Google User",
      email: user.email || "",
      photoURL: user.photoURL || "",
      loginAt: serverTimestamp(),
      userAgent: navigator.userAgent
    });
  } catch (error) {
    console.error("Failed to record login:", error);
  }
}

async function ensureDecksForUser(user) {
  const cached = loadCachedUserData(user.uid);
  const activeFromStorage = localStorage.getItem(activeDeckKey(user.uid));

  if (cached?.decks && Object.keys(cached.decks).length) {
    decks = cached.decks;
    activeDeckId = activeFromStorage || cached.activeDeckId || Object.keys(decks)[0];
    if (activeDeckId && decks[activeDeckId]) setQuizFromActiveDeck();
  } else {
    decks = {};
    activeDeckId = null;
    clearActiveQuizCache();
  }

  if (!decksLoaded) renderDecksUI();

  // One-time migration for the old v2 localStorage cards.
  if (!legacyMigrationDone) {
    const legacy = safeParseArray(localStorage.getItem("quizData"));
    if (legacy.length && Object.keys(decks).length === 0) {
      const deckId = createDeckId();
      decks[deckId] = {
        name: "Imported from v2.0",
        cards: legacy,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      activeDeckId = deckId;
      await saveDeckToCloud(deckId);
      setQuizFromActiveDeck();
    }
    legacyMigrationDone = true;
  }

  if (!Object.keys(decks).length) {
    const deckId = createDeckId();
    decks[deckId] = {
      name: "General",
      cards: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    activeDeckId = deckId;
    await saveDeckToCloud(deckId);
    setQuizFromActiveDeck();
  }

  if (!activeDeckId || !decks[activeDeckId]) {
    activeDeckId = Object.keys(decks)[0];
    setQuizFromActiveDeck();
  }

  renderDecksUI();
}

function subscribeToDecks(user) {
  if (stopDeckListener) stopDeckListener();
  const decksRef = ref(rtdb, `users/${user.uid}/decks`);
  let firstSnapshot = true;

  stopDeckListener = onValue(decksRef, async (snapshot) => {
    const remote = snapshot.val() || {};
    const normalized = Object.fromEntries(
      Object.entries(remote).map(([id, deck]) => [id, normalizeDeck(deck)])
    );

    if (Object.keys(normalized).length) {
      decks = normalized;
      const storedActive = localStorage.getItem(activeDeckKey(user.uid));
      if (storedActive && decks[storedActive]) activeDeckId = storedActive;
      if (!activeDeckId || !decks[activeDeckId]) activeDeckId = Object.keys(decks)[0];
      setQuizFromActiveDeck();
      renderDecksUI();
    }

    if (firstSnapshot) {
      firstSnapshot = false;
      decksLoaded = true;
      await ensureDecksForUser(user);
    }
  }, (error) => {
    console.error("Deck sync listener failed:", error);
    showSyncStatus("Cloud sync unavailable", true);
  });
}

async function initAuth() {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (error) {
    console.warn("Auth persistence setup failed:", error);
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;
    if (!user) {
      if (stopDeckListener) {
        stopDeckListener();
        stopDeckListener = null;
      }
      decks = {};
      activeDeckId = null;
      decksLoaded = false;
      quiz = [];
      clearActiveQuizCache();
      activeChatUid = null;
      if (stopChatListListener) { stopChatListListener(); stopChatListListener = null; }
      if (stopMessagesListener) { stopMessagesListener(); stopMessagesListener = null; }
      updateAuthUI(null);
      updateAllDeckUI();
      updateStat();
      openMandatoryAuth();
      return;
    }

    updateAuthUI(user);
    showSyncStatus("Connecting your Google account…");
    await recordLogin(user);
    await ensureUserProfile(user);
    subscribeToDecks(user);
    subscribeToChatList(user);
  });

  try {
    await getRedirectResult(auth);
  } catch (error) {
    console.error("Google redirect sign-in error:", error);
    showAuthMessage(getAuthErrorMessage(error), true);
  }
}

function createDeckId() {
  if (window.crypto?.randomUUID) return `deck-${crypto.randomUUID()}`;
  return `deck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function saveDeckToCloud(deckId = activeDeckId) {
  if (!currentUser || !deckId || !decks[deckId]) return false;
  const deck = normalizeDeck(decks[deckId]);
  deck.updatedAt = Date.now();
  decks[deckId] = deck;
  localCache();
  try {
    await set(ref(rtdb, `users/${currentUser.uid}/decks/${deckId}`), {
      name: deck.name,
      cards: deck.cards,
      createdAt: deck.createdAt || Date.now(),
      updatedAt: serverTimestamp()
    });
    showSyncStatus("Saved to your Google account", false, 1800);
    return true;
  } catch (error) {
    console.error("Cloud save failed:", error);
    showSyncStatus("Saved locally • cloud sync failed", true);
    return false;
  }
}

function showSyncStatus(message, isError = false, clearAfter = 0) {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  if (clearAfter) setTimeout(() => {
    if (el.textContent === message) el.classList.add("hidden");
  }, clearAfter);
}

function updateAllDeckUI() {
  renderDecksUI();
  const activeName = getActiveDeck()?.name || "No deck selected";
  document.querySelectorAll("[data-active-deck-name]").forEach(el => el.textContent = activeName);
}

function renderDecksUI() {
  const select = document.getElementById("deckSelect");
  const list = document.getElementById("deckList");
  const nameEl = document.getElementById("currentDeckName");
  const countEl = document.getElementById("currentDeckCount");

  if (select) {
    select.innerHTML = "";
    const entries = Object.entries(decks);
    if (!entries.length) {
      select.innerHTML = `<option value="">No decks yet</option>`;
      select.disabled = true;
    } else {
      select.disabled = false;
      entries.forEach(([id, deck]) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = deck.name;
        option.selected = id === activeDeckId;
        select.appendChild(option);
      });
    }
  }

  if (list) {
    list.innerHTML = "";
    Object.entries(decks).forEach(([id, deck]) => {
      const row = document.createElement("div");
      row.className = `deck-mini-row ${id === activeDeckId ? "active" : ""}`;
      row.innerHTML = `
        <button class="deck-mini-main" type="button" onclick="selectDeck('${escapeAttribute(id)}')">
          <span class="deck-mini-icon">📚</span>
          <span class="deck-mini-copy"><strong>${escapeHTML(deck.name)}</strong><small>${deck.cards.length} card${deck.cards.length === 1 ? "" : "s"}</small></span>
        </button>
        <button class="deck-mini-delete" type="button" title="Delete deck" onclick="deleteDeck('${escapeAttribute(id)}', event)">✕</button>
      `;
      list.appendChild(row);
    });
  }

  if (nameEl) nameEl.textContent = getActiveDeck()?.name || "No deck";
  if (countEl) countEl.textContent = `${quiz.length} card${quiz.length === 1 ? "" : "s"}`;
  updateStat();
}

window.selectDeck = async function (id) {
  if (!currentUser || !decks[id]) return openMandatoryAuth();
  activeDeckId = id;
  setActiveDeckLocal(id);
  setQuizFromActiveDeck();
  renderDecksUI();
  showSyncStatus(`Opened “${decks[id].name}”`, false, 1400);
};

window.handleDeckSelect = function (event) {
  window.selectDeck(event.target.value);
};

window.createDeck = async function () {
  if (!currentUser) return openMandatoryAuth();
  const input = document.getElementById("newDeckName");
  const name = input?.value.trim();
  if (!name) {
    input?.focus();
    return;
  }
  const deckId = createDeckId();
  decks[deckId] = {
    name: name.slice(0, 80),
    cards: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  activeDeckId = deckId;
  setActiveDeckLocal(deckId);
  setQuizFromActiveDeck();
  renderDecksUI();
  if (input) input.value = "";
  await saveDeckToCloud(deckId);
  showReviewer();
};

window.deleteDeck = async function (id, event) {
  event?.stopPropagation();
  if (!currentUser || !decks[id]) return;
  const count = decks[id].cards.length;
  if (Object.keys(decks).length === 1) {
    return alert("Keep at least one deck. Create another deck before deleting this one.");
  }
  if (!confirm(`Delete the “${decks[id].name}” deck and its ${count} card${count === 1 ? "" : "s"}?`)) return;

  delete decks[id];
  if (stopDeckListener) { /* listener stays active */ }
  try {
    await remove(ref(rtdb, `users/${currentUser.uid}/decks/${id}`));
  } catch (error) {
    console.error(error);
    showSyncStatus("Deck deleted locally • cloud delete failed", true);
  }
  if (activeDeckId === id) {
    activeDeckId = Object.keys(decks)[0];
    setActiveDeckLocal(activeDeckId);
    setQuizFromActiveDeck();
  }
  renderDecksUI();
  if (document.getElementById("cardContainer")) showReviewer();
};

window.addQuestion = async function () {
  if (!currentUser) {
    openMandatoryAuth();
    showAuthMessage("Please sign in with Google before adding flashcards.", true);
    return;
  }
  if (!getActiveDeck()) {
    await window.createDeck();
    return;
  }

  const qInput = document.getElementById("question");
  const aInput = document.getElementById("answer");
  const q = qInput?.value.trim();
  const a = aInput?.value.trim();

  if (!q || !a) return alert("Fill in both Question and Answer.");

  getActiveDeck().cards.push({ question: q, answer: a });
  quiz = [...getActiveDeck().cards];
  getActiveDeck().updatedAt = Date.now();
  localCache();
  updateAllDeckUI();
  updateStat();
  if (qInput) qInput.value = "";
  if (aInput) aInput.value = "";
  showReviewer();
  await saveDeckToCloud();
};

window.deleteQuestion = async function (index) {
  if (!getActiveDeck()) return;
  if (!confirm("Delete this question?")) return;
  getActiveDeck().cards.splice(index, 1);
  quiz = [...getActiveDeck().cards];
  localCache();
  renderDecksUI();
  renderCard();
  await saveDeckToCloud();
};

window.deleteAllCards = async function () {
  if (!getActiveDeck() || quiz.length === 0) {
    alert("No cards to delete!");
    return;
  }
  if (!confirm(`Delete all ${quiz.length} cards from “${getActiveDeck().name}”?`)) return;
  getActiveDeck().cards = [];
  quiz = [];
  currentIndex = 0;
  localCache();
  renderDecksUI();
  renderCard();
  updateStat();
  await saveDeckToCloud();
  alert("🗑 All cards deleted from this deck.");
};

window.deleteCurrentCard = async function (event) {
  event.stopPropagation();
  if (!getActiveDeck()) return;
  if (!confirm("Delete this card?")) return;
  getActiveDeck().cards.splice(currentIndex, 1);
  quiz = [...getActiveDeck().cards];
  if (currentIndex >= quiz.length) currentIndex = Math.max(0, quiz.length - 1);
  localCache();
  renderDecksUI();
  renderCard();
  await saveDeckToCloud();
};

window.shuffleCards = async function () {
  if (quiz.length <= 1) return alert("Not enough cards to shuffle!");
  const shuffled = shuffleArray(quiz);
  quiz = shuffled;
  if (getActiveDeck()) getActiveDeck().cards = [...shuffled];
  currentIndex = 0;
  localCache();
  renderCard();
  await saveDeckToCloud();
  alert("🔀 Cards shuffled and synced.");
};

window.saveQuizOnline = async function () {
  if (!currentUser) return openMandatoryAuth();
  if (!getActiveDeck()) return alert("Create or select a deck first.");
  if (quiz.length === 0) return alert("No questions in this deck yet.");

  try {
    const deck = getActiveDeck();
    const docRef = await addDoc(collection(db, "quizzes"), {
      title: deck.name,
      data: quiz,
      ownerUid: currentUser.uid,
      ownerName: currentUser.displayName || "Google User",
      ownerEmail: currentUser.email || "",
      ownerPhotoURL: currentUser.photoURL || "",
      createdAt: firestoreServerTimestamp(),
      version: 2
    });

    const link = `${window.location.origin}${window.location.pathname}?quiz=${docRef.id}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    const input = document.getElementById("sharedLinkInput");
    if (input) input.value = link;
    alert("✅ Share link created and copied!\n\nAnyone with the link can preview the cards and see the Google account name that shared them.");
  } catch (e) {
    console.error(e);
    alert("Error saving the share link. Check your Firestore rules and internet connection.");
  }
};

function parseSharedInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.href);
    return url.searchParams.get("quiz") || url.searchParams.get("shared") || raw;
  } catch {
    return raw;
  }
}

window.loadSharedQuiz = async function (inputOverride = "") {
  const input = document.getElementById("sharedLinkInput");
  const raw = inputOverride || input?.value || "";
  const id = parseSharedInput(raw);
  if (!id) return alert("Paste a WHITE_QUIZXYZ share link first.");

  const button = document.getElementById("loadSharedBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "Loading…";
  }

  try {
    const snap = await getDoc(doc(db, "quizzes", id));
    if (!snap.exists()) throw new Error("Shared deck not found.");
    const data = snap.data();
    sharedQuizCache = {
      id,
      title: data.title || "Shared Deck",
      cards: Array.isArray(data.data) ? data.data.filter(c => c && c.question && c.answer).map(c => ({ question: String(c.question), answer: String(c.answer) })) : [],
      ownerUid: data.ownerUid || "",
      ownerName: data.ownerName || "Google User",
      ownerEmail: data.ownerEmail || "",
      ownerPhotoURL: data.ownerPhotoURL || ""
    };
    renderSharedPreview(sharedQuizCache);
    if (input) input.value = raw;
  } catch (error) {
    console.error(error);
    alert("❌ Shared deck not found or the link is invalid.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Load Shared Deck";
    }
  }
};

function renderSharedPreview(shared) {
  const wrap = document.getElementById("sharedPreview");
  if (!wrap) return;
  const owner = escapeHTML(shared.ownerName || "Google User");
  const email = escapeHTML(maskEmail(shared.ownerEmail));
  const avatar = escapeAttribute(shared.ownerPhotoURL || "logo.png");

  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <div class="shared-owner-row">
      <img src="${avatar}" alt="Shared by" class="shared-owner-avatar">
      <div class="shared-owner-copy">
        <span class="shared-eyebrow">SHARED DECK</span>
        <strong>${escapeHTML(shared.title)}</strong>
        <small>from <b>${owner}</b>${email ? ` • ${email}` : ""}</small>
      </div>
    </div>
    <div class="shared-card-summary"><span>${shared.cards.length} cards</span><span>🔗 Public preview</span></div>
    <div class="shared-card-list">
      ${shared.cards.length ? shared.cards.map((c, i) => `
        <button class="shared-card-item" type="button" onclick="toggleSharedCard(this)">
          <span class="shared-card-number">${i + 1}</span>
          <span class="shared-card-copy"><strong>${escapeHTML(c.question)}</strong><small>${escapeHTML(c.answer)}</small></span>
        </button>
      `).join("") : `<div class="shared-empty">This shared deck has no cards.</div>`}
    </div>
    ${currentUser ? `<button class="btn-primary btn-full" onclick="importSharedDeck()">＋ Import to My Decks</button>` : `<div class="shared-login-hint">Sign in with Google above to import this deck into your account.</div>`}
  `;
}

window.toggleSharedCard = function (button) {
  button.classList.toggle("revealed");
};

window.importSharedDeck = async function () {
  if (!currentUser) return openMandatoryAuth();
  if (!sharedQuizCache || !sharedQuizCache.cards.length) return alert("Load a shared deck first.");
  const baseName = sharedQuizCache.title || "Imported Deck";
  const deckId = createDeckId();
  decks[deckId] = {
    name: `${baseName} (Imported)`.slice(0, 80),
    cards: sharedQuizCache.cards.map(c => ({ ...c })),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  activeDeckId = deckId;
  setActiveDeckLocal(deckId);
  setQuizFromActiveDeck();
  renderDecksUI();
  await saveDeckToCloud(deckId);
  showReviewer();
  showSyncStatus("Shared deck imported and synced", false, 2200);
};

async function loadSharedFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("quiz") || params.get("shared");
  if (!id) return;
  await window.loadSharedQuiz(`${window.location.origin}${window.location.pathname}?quiz=${encodeURIComponent(id)}`);
}

// -----------------------------
// FLASHCARD REVIEWER
// -----------------------------
window.showReviewer = function () {
  const reviewer = document.getElementById("reviewer");
  if (reviewer) reviewer.classList.remove("hidden");
  currentIndex = Math.min(currentIndex, Math.max(0, quiz.length - 1));
  renderCard();
};

function renderCard() {
  const container = document.getElementById("cardContainer");
  const counter = document.getElementById("counter");
  if (!container || !counter) return;

  container.innerHTML = "";
  if (quiz.length === 0) {
    container.innerHTML = `<div class="empty-card-state"><div class="empty-icon"></div><strong>No flashcards in this deck yet.</strong><br><span>Add cards from Home to start studying.</span></div>`;
    counter.innerText = "0 / 0";
    return;
  }

  const item = quiz[currentIndex];
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="inner">
      <div class="front">
        <p class="questiontag">Question:</p>
        ${escapeHTML(item.question)}
        <button class="delete-btn" onclick="deleteCurrentCard(event)">✖</button>
      </div>
      <div class="back">
        <p class="answer">Answer:</p>
        ${escapeHTML(item.answer)}
        <button class="delete-btn" onclick="deleteCurrentCard(event)">✖</button>
      </div>
    </div>
  `;
  card.onclick = () => card.classList.toggle("flip");
  container.appendChild(card);
  counter.innerText = `${currentIndex + 1} / ${quiz.length}`;
}

window.nextCard = function () {
  if (currentIndex < quiz.length - 1) {
    currentIndex++;
    renderCard();
  }
};

window.prevCard = function () {
  if (currentIndex > 0) {
    currentIndex--;
    renderCard();
  }
};

// -----------------------------
// MULTIPLE CHOICE
// -----------------------------
window.openMultipleChoice = function () {
  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("multipleChoiceCard")?.classList.remove("hidden");
  mcIndex = 0;
  buildMultipleChoiceSet();
  renderMultipleChoice();
};

function buildMultipleChoiceSet() {
  mcQuestions = quiz.map((item, index) => {
    const correctAnswer = item.answer;
    const otherAnswers = quiz
      .filter((_, answerIndex) => answerIndex !== index)
      .map(other => other.answer)
      .filter(answer => answer && answer !== correctAnswer);
    const distractors = shuffleArray([...new Set(otherAnswers)]).slice(0, 3);
    const choices = shuffleArray([correctAnswer, ...distractors].map(text => ({ text, correct: text === correctAnswer })));
    return { question: item.question, answer: correctAnswer, choices };
  });
}

function renderMultipleChoice() {
  const questionCard = document.getElementById("mcQuestionCard");
  const choicesContainer = document.getElementById("mcChoices");
  const feedback = document.getElementById("mcFeedback");
  const counter = document.getElementById("mcCounter");
  const prevBtn = document.getElementById("mcPrevBtn");
  const nextBtn = document.getElementById("mcNextBtn");
  if (!questionCard || !choicesContainer || !feedback || !counter) return;

  if (quiz.length === 0) {
    counter.innerText = "0 / 0";
    questionCard.innerHTML = `<span class="mc-question-tag">QUESTION</span><div class="mc-question-text">No flashcards available.</div>`;
    choicesContainer.innerHTML = `<div class="mc-empty-state">Add flashcards to create choices from your saved answers.</div>`;
    feedback.classList.add("hidden");
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  if (mcQuestions.length !== quiz.length) buildMultipleChoiceSet();

  const uniqueAnswers = new Set(quiz.map(item => item.answer).filter(Boolean));
  const current = mcQuestions[Math.min(mcIndex, mcQuestions.length - 1)];
  counter.innerText = `${mcIndex + 1} / ${quiz.length}`;

  if (uniqueAnswers.size < 4) {
    questionCard.innerHTML = `<span class="mc-question-tag">QUESTION</span><div class="mc-question-text">${escapeHTML(current.question)}</div>`;
    choicesContainer.innerHTML = `<div class="mc-empty-state">Need <strong>4 different answers</strong> to build A, B, C, D choices.</div>`;
    feedback.classList.add("hidden");
    if (prevBtn) prevBtn.disabled = mcIndex === 0;
    if (nextBtn) nextBtn.disabled = mcIndex === quiz.length - 1;
    return;
  }

  mcSelected = null;
  questionCard.innerHTML = `<span class="mc-question-tag">QUESTION ${mcIndex + 1}</span><div class="mc-question-text">${escapeHTML(current.question)}</div><span class="mc-question-footer">Select the best answer below</span>`;
  choicesContainer.innerHTML = "";
  ["A", "B", "C", "D"].forEach((letter, index) => {
    const choice = current.choices[index];
    if (!choice) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mc-choice-card";
    button.innerHTML = `<span class="mc-choice-letter">${letter}</span><span class="mc-choice-text">${escapeHTML(choice.text)}</span>`;
    button.addEventListener("click", () => selectMultipleChoice(index));
    choicesContainer.appendChild(button);
  });
  feedback.className = "mc-feedback hidden";
  feedback.innerHTML = "";
  if (prevBtn) {
    prevBtn.disabled = mcIndex === 0;
    prevBtn.style.opacity = mcIndex === 0 ? "0.45" : "1";
  }
  if (nextBtn) {
    nextBtn.disabled = mcIndex === quiz.length - 1;
    nextBtn.style.opacity = mcIndex === quiz.length - 1 ? "0.45" : "1";
  }
}

window.selectMultipleChoice = function (selectedIndex) {
  if (!mcQuestions.length) return;
  const current = mcQuestions[mcIndex];
  const buttons = [...document.querySelectorAll(".mc-choice-card")];
  const feedback = document.getElementById("mcFeedback");
  if (!feedback || !buttons[selectedIndex]) return;
  if (mcSelected !== null) return;
  mcSelected = selectedIndex;
  buttons.forEach((button, index) => {
    button.disabled = true;
    if (current.choices[index]?.correct) button.classList.add("correct");
    if (index === selectedIndex && !current.choices[index]?.correct) button.classList.add("wrong");
  });
  feedback.classList.remove("hidden");
  if (current.choices[selectedIndex]?.correct) {
    feedback.classList.add("success");
    feedback.innerHTML = `<strong>✓ Correct!</strong> Great job.`;
  } else {
    feedback.classList.add("error");
    feedback.innerHTML = `<strong>✕ Not quite.</strong> Correct answer: <b>${escapeHTML(current.answer)}</b>`;
  }
};

window.nextMultipleChoice = function () {
  if (mcIndex < mcQuestions.length - 1) { mcIndex++; renderMultipleChoice(); }
};

window.prevMultipleChoice = function () {
  if (mcIndex > 0) { mcIndex--; renderMultipleChoice(); }
};

window.shuffleMultipleChoice = function () {
  if (quiz.length < 4) return alert("Add at least 4 different answers first.");
  mcQuestions = shuffleArray(mcQuestions.map(item => ({ ...item, choices: shuffleArray(item.choices) })));
  mcIndex = 0;
  renderMultipleChoice();
};

function shuffleArray(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// -----------------------------
// SETTINGS / QA / PROFILE / MUSIC / ABOUT
// -----------------------------
window.toggleSettings = function () {
  const card = document.getElementById("settingsCard");
  if (card) card.classList.toggle("hidden");
};

document.addEventListener("click", function (e) {
  const card = document.getElementById("settingsCard");
  const btn = document.getElementById("settingsBtn");
  if (card && btn && !card.contains(e.target) && !btn.contains(e.target)) card.classList.add("hidden");
});

window.openQA = function () {
  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("qaCard")?.classList.remove("hidden");
  renderQA();
};

function renderQA() {
  const container = document.getElementById("qaContainer");
  if (!container) return;
  container.innerHTML = quiz.length ? quiz.map((item, index) => `
    <div class="qa-item" onclick="this.classList.toggle('active')">
      <div class="qa-question">Q ${index + 1}. ${escapeHTML(item.question)}</div>
      <div class="qa-answer">Answer: ${escapeHTML(item.answer)}</div>
    </div>
  `).join("") : `<div class="qa-item"><div class="qa-question">No flashcards available.</div></div>`;
}

function slugifyUsername(value) { return String(value||"").toLowerCase().trim().replace(/[^a-z0-9_]+/g,"").slice(0,24); }
function makeDefaultUsername(user) { const base=slugifyUsername(user.displayName || user.email?.split("@")[0] || "student") || "student"; return `${base}${String(user.uid).slice(-4).toLowerCase()}`.slice(0,24); }

async function ensureUserProfile(user) {
  if (!user) return;
  try {
    const snap=await get(ref(rtdb,`users/${user.uid}/profile`));
    if(snap.exists()) profileData=snap.val()||{};
    else { profileData={username:makeDefaultUsername(user),bio:"",createdAt:Date.now(),updatedAt:Date.now()}; await set(ref(rtdb,`users/${user.uid}/profile`),profileData); }
    const p=profileData||{}; const username=p.username||makeDefaultUsername(user);
    await update(ref(rtdb,`userDirectory/${user.uid}`),{uid:user.uid,username,usernameLower:username.toLowerCase(),displayName:user.displayName||"Google User",emailMasked:maskEmail(user.email||""),photoURL:user.photoURL||"",bio:p.bio||"",updatedAt:serverTimestamp()});
    fillProfileUI();
  }catch(e){console.error("Profile bootstrap failed",e);}
}

function fillProfileUI(){
  if(!currentUser)return; const p=profileData||{};
  const u=document.getElementById("username"), em=document.getElementById("email"), b=document.getElementById("bio"), id=document.getElementById("profileIdentity");
  if(u)u.value=p.username||""; if(em)em.value=currentUser.email||""; if(b)b.value=p.bio||"";
  if(id)id.innerHTML=`<img src="${escapeAttribute(currentUser.photoURL||'logo.png')}" alt=""><div><strong>@${escapeHTML(p.username||makeDefaultUsername(currentUser))}</strong><span>${escapeHTML(currentUser.displayName||'Google User')}</span></div>`;
}
window.openProfile=function(){ if(!currentUser)return openMandatoryAuth(); document.getElementById("settingsCard")?.classList.add("hidden"); document.getElementById("profileCard")?.classList.remove("hidden"); fillProfileUI(); };
window.closeProfile=function(){ document.getElementById("profileCard")?.classList.add("hidden"); };
window.saveProfile=async function(){
  if(!currentUser)return openMandatoryAuth();
  const raw=slugifyUsername(document.getElementById("username")?.value||""); const bio=String(document.getElementById("bio")?.value||"").trim().slice(0,160);
  if(raw.length<3)return alert("Username must be at least 3 characters and may contain letters, numbers, and underscores.");
  try{
    const snap=await get(query(ref(rtdb,"userDirectory"),orderByChild("usernameLower"),equalTo(raw)));
    let taken=false; snap.forEach(x=>{if(x.key!==currentUser.uid)taken=true;}); if(taken)return alert("That username is already taken.");
    profileData={...(profileData||{}),username:raw,bio,updatedAt:Date.now()};
    await update(ref(rtdb,`users/${currentUser.uid}/profile`),profileData);
    await update(ref(rtdb,`userDirectory/${currentUser.uid}`),{uid:currentUser.uid,username:raw,usernameLower:raw,displayName:currentUser.displayName||"Google User",emailMasked:maskEmail(currentUser.email||""),photoURL:currentUser.photoURL||"",bio,updatedAt:serverTimestamp()});
    fillProfileUI(); renderChatList(); alert("✅ Profile saved!");
  }catch(e){console.error(e);alert("Could not save your profile. Check Firebase Realtime Database rules.");}
};

window.backToSettings = function () {
  document.getElementById("qaCard")?.classList.add("hidden");
  document.getElementById("multipleChoiceCard")?.classList.add("hidden");
  document.getElementById("musicCard")?.classList.add("hidden");
  document.getElementById("aboutadminCard")?.classList.add("hidden");
  document.getElementById("settingsCard")?.classList.remove("hidden");
};

let playlist = ["music1.mp3", "music2.mp3", "music3.mp3", "music4.mp3", "music5.mp3", "music6.mp3", "music7.mp3", "music8.mp3", "music9.mp3", "music10.mp3", "music11.mp3", "music12.mp3"];
let currentSong = 0;

function loadSong(index) {
  if (!audio) return;
  audio.src = playlist[index];
  const title = document.getElementById("musicTitle");
  if (title) title.innerText = playlist[index];
}

window.openMusic = function () {
  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("musicCard")?.classList.remove("hidden");
  if (audio && !audio.src) loadSong(currentSong);
};
window.togglePlay = function () { if (audio) audio.paused ? audio.play() : audio.pause(); };
window.nextMusic = function () { currentSong = (currentSong + 1) % playlist.length; loadSong(currentSong); audio?.play(); };
window.prevMusic = function () { currentSong = (currentSong - 1 + playlist.length) % playlist.length; loadSong(currentSong); audio?.play(); };

window.openAbout = function () {
  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("aboutadminCard")?.classList.remove("hidden");
};

// -----------------------------
// CHAT
// -----------------------------
function conversationId(a,b){return [String(a),String(b)].sort().join("__");}
function normalizeChatMeta(v={},fallback=""){return {otherUid:String(v.otherUid||fallback),conversationId:String(v.conversationId||""),username:String(v.username||"user"),displayName:String(v.displayName||"User"),photoURL:String(v.photoURL||"logo.png"),lastMessage:String(v.lastMessage||""),lastMessageAt:Number(v.lastMessageAt||0),pinned:!!v.pinned,unread:Number(v.unread||0)};}
function renderChatList(){
  const el=document.getElementById("chatList");if(!el)return; const rows=Object.values(chatUsers).map(normalizeChatMeta).sort((a,b)=>(Number(b.pinned)-Number(a.pinned))||(b.lastMessageAt-a.lastMessageAt));
  el.innerHTML=rows.length?rows.map(c=>`<div class="chat-user-row ${activeChatUid===c.otherUid?'active':''}" onclick="openConversation('${escapeAttribute(c.otherUid)}')"><img class="chat-user-avatar" src="${escapeAttribute(c.photoURL)}" alt=""><span class="chat-user-copy"><strong>@${escapeHTML(c.username)}</strong><small>${escapeHTML(c.lastMessage||'Start a conversation')}</small></span><span class="chat-row-actions"><button class="pin-chat-btn ${c.pinned?'pinned':''}" type="button" onclick="togglePinnedChat(event,'${escapeAttribute(c.otherUid)}')">${c.pinned?'📌':'📍'}</button></span></div>`).join(""): '<div class="chat-empty-list">No conversations yet.<br>Search a username above to start one.</div>';
  const unread=rows.reduce((n,c)=>n+Math.max(0,c.unread),0), badge=document.getElementById("chatBadge"); if(badge){badge.textContent=unread>99?'99+':unread;badge.classList.toggle('hidden',!unread);}
}
function subscribeToChatList(user){if(stopChatListListener)stopChatListListener();stopChatListListener=onValue(ref(rtdb,`userChats/${user.uid}`),snap=>{const raw=snap.val()||{};chatUsers=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,normalizeChatMeta(v,k)]));renderChatList();});}
async function getDirectoryUser(uid){const s=await get(ref(rtdb,`userDirectory/${uid}`));return s.exists()?s.val():null;}
async function ensureConversation(target){const cid=conversationId(currentUser.uid,target.uid), rr=ref(rtdb,`conversations/${cid}`), s=await get(rr);if(!s.exists())await update(rr,{members:{[currentUser.uid]:true,[target.uid]:true},createdAt:serverTimestamp()});return cid;}
window.openChat=async function(){if(!currentUser)return openMandatoryAuth();document.getElementById("settingsCard")?.classList.add("hidden");document.getElementById("chatCard")?.classList.remove("hidden");renderChatList();document.getElementById("chatUserSearch")?.focus();};
window.closeChat=function(){document.getElementById("chatCard")?.classList.add("hidden");document.getElementById("chatCard")?.classList.remove("chat-conversation-open");activeChatUid=null;if(stopMessagesListener){stopMessagesListener();stopMessagesListener=null;}};
window.showChatListMobile=function(){document.getElementById("chatCard")?.classList.remove("chat-conversation-open");};
window.searchChatUsers=async function(){
  if(!currentUser)return;const term=slugifyUsername(document.getElementById("chatUserSearch")?.value||"");const out=document.getElementById("chatSearchResults");if(!out)return;if(term.length<2){out.innerHTML="";return;}out.innerHTML='<div class="chat-search-empty">Searching…</div>';
  try{const snap=await get(query(ref(rtdb,"userDirectory"),orderByChild("usernameLower"),startAt(term),endAt(term+"\uf8ff")));const a=[];snap.forEach(x=>{if(x.key!==currentUser.uid)a.push(x.val());});out.innerHTML=a.slice(0,12).map(u=>`<button class="chat-user-row chat-search-result" type="button" onclick="startChatWithUser('${escapeAttribute(u.uid)}')"><img class="chat-user-avatar" src="${escapeAttribute(u.photoURL||'logo.png')}" alt=""><span class="chat-user-copy"><strong>@${escapeHTML(u.username||'user')}</strong><small>${escapeHTML(u.displayName||'WHITEQUIZ user')} • ${escapeHTML(u.emailMasked||'')}</small></span></button>`).join("")||'<div class="chat-search-empty">No matching username found.</div>';}catch(e){console.error(e);out.innerHTML='<div class="chat-search-empty">Search unavailable. Check your database rules.</div>';}
};
window.startChatWithUser=async function(uid){if(!currentUser||uid===currentUser.uid)return;try{const target=await getDirectoryUser(uid);if(!target)return;const cid=await ensureConversation({uid,...target});const mine=normalizeChatMeta(chatUsers[uid],uid), p=profileData||{};await update(ref(rtdb),{[`userChats/${currentUser.uid}/${uid}`]:{otherUid:uid,conversationId:cid,username:target.username||'user',displayName:target.displayName||'User',photoURL:target.photoURL||'',lastMessage:mine.lastMessage,lastMessageAt:mine.lastMessageAt,pinned:mine.pinned,unread:0,updatedAt:serverTimestamp()},[`userChats/${uid}/${currentUser.uid}`]:{otherUid:currentUser.uid,conversationId:cid,username:p.username||makeDefaultUsername(currentUser),displayName:currentUser.displayName||'Google User',photoURL:currentUser.photoURL||'',lastMessage:mine.lastMessage,lastMessageAt:mine.lastMessageAt,pinned:false,unread:0,updatedAt:serverTimestamp()}});document.getElementById("chatSearchResults").innerHTML="";document.getElementById("chatUserSearch").value="";openConversation(uid);}catch(e){console.error(e);alert("Could not start this conversation. Check Firebase rules.");}};
window.openConversation=async function(uid){if(!currentUser)return openMandatoryAuth();const target=await getDirectoryUser(uid);if(!target)return;activeChatUid=uid;document.getElementById("chatCard")?.classList.add("chat-conversation-open");document.getElementById("conversationEmpty")?.classList.add("hidden");document.getElementById("conversationView")?.classList.remove("hidden");const u=document.getElementById("conversationUser");if(u)u.innerHTML=`<img src="${escapeAttribute(target.photoURL||'logo.png')}" alt=""><div><strong>@${escapeHTML(target.username||'user')}</strong><span>${escapeHTML(target.displayName||'User')}</span></div>`;await update(ref(rtdb,`userChats/${currentUser.uid}/${uid}`),{unread:0});if(stopMessagesListener)stopMessagesListener();stopMessagesListener=onValue(ref(rtdb,`conversations/${conversationId(currentUser.uid,uid)}/messages`),snap=>renderMessages(snap.val()||{}));renderChatList();setTimeout(()=>document.getElementById("messageInput")?.focus(),60);};
function renderMessages(raw){const list=document.getElementById("messagesList");if(!list)return;const rows=Object.values(raw).sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0));if(!rows.length){list.innerHTML='<div class="chat-search-empty" style="margin:auto">No messages yet. Say hello 👋</div>';return;}list.innerHTML=rows.map(m=>{const mine=m.senderUid===currentUser?.uid,t=Number(m.createdAt||0);return `<div class="message-bubble-wrap ${mine?'mine':'theirs'}"><div class="message-bubble ${mine?'mine':'theirs'}"><p>${escapeHTML(m.text||'')}</p><span class="message-time">${t?new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Sending…'}</span></div></div>`;}).join('');list.scrollTop=list.scrollHeight;}
window.sendChatMessage=async function(e){e?.preventDefault();if(!currentUser||!activeChatUid)return;const inp=document.getElementById("messageInput"),text=String(inp?.value||'').trim();if(!text)return;try{const target=await getDirectoryUser(activeChatUid);if(!target)return;const cid=await ensureConversation({uid:activeChatUid,...target});const sent=Date.now();await set(push(ref(rtdb,`conversations/${cid}/messages`)),{senderUid:currentUser.uid,senderName:currentUser.displayName||'Google User',text:text.slice(0,1000),createdAt:serverTimestamp()});const old=normalizeChatMeta(chatUsers[activeChatUid],activeChatUid),p=profileData||{};await update(ref(rtdb),{[`userChats/${currentUser.uid}/${activeChatUid}`]:{otherUid:activeChatUid,conversationId:cid,username:target.username||'user',displayName:target.displayName||'User',photoURL:target.photoURL||'',lastMessage:text,lastMessageAt:sent,pinned:old.pinned,unread:0,updatedAt:serverTimestamp()},[`userChats/${activeChatUid}/${currentUser.uid}`]:{otherUid:currentUser.uid,conversationId:cid,username:p.username||makeDefaultUsername(currentUser),displayName:currentUser.displayName||'Google User',photoURL:currentUser.photoURL||'',lastMessage:text,lastMessageAt:sent,pinned:false,unread:Number(normalizeChatMeta(chatUsers[activeChatUid],activeChatUid).unread||0)+1,updatedAt:serverTimestamp()}});if(inp)inp.value='';}catch(err){console.error(err);alert('Message could not be sent. Check Firebase rules.');}};
window.togglePinnedChat=async function(e,uid){e?.stopPropagation();const m=normalizeChatMeta(chatUsers[uid],uid);try{await update(ref(rtdb,`userChats/${currentUser.uid}/${uid}`),{pinned:!m.pinned});}catch(err){console.error(err);}};

// -----------------------------
// PWA INSTALL
// -----------------------------
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallUI() {
  document.querySelectorAll("[data-install-app]").forEach(item => {
    const installed = isStandalone();
    item.classList.toggle("install-installed", installed);
    const title = item.querySelector("strong");
    const desc = item.querySelector("p");
    if (installed) {
      if (title) title.textContent = "App Installed";
      if (desc) desc.textContent = "WHITE_QUIZXYZ is on your phone";
    } else {
      if (title) title.textContent = "Install App";
      if (desc) desc.textContent = "Add WHITE_QUIZXYZ to your home screen";
    }
  });
}

window.installApp = async function () {
  if (isStandalone()) return showInstallInfo("WHITE_QUIZXYZ is already installed on this device.");
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice?.outcome === "accepted") showInstallInfo("Installed! You can now open WHITE_QUIZXYZ from your home screen.");
    deferredInstallPrompt = null;
    updateInstallUI();
    return;
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  showInstallInfo(isIOS ? "On iPhone/iPad: tap Share (□↑) → Add to Home Screen." : "Use your browser menu → Install app / Add to home screen. The option appears over HTTPS after the site loads.");
};

function showInstallInfo(message) {
  const box = document.getElementById("installInfo");
  const text = document.getElementById("installInfoText");
  if (!box || !text) return;
  text.textContent = message;
  box.classList.remove("hidden");
}
window.closeInstallInfo = function () { document.getElementById("installInfo")?.classList.add("hidden"); };
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstallPrompt = event; updateInstallUI(); });
window.addEventListener("appinstalled", () => { deferredInstallPrompt = null; updateInstallUI(); });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Service worker registration failed:", error)));
}

// Swipe support
let startX = 0;
let endX = 0;
function bindSwipe() {
  const cardContainer = document.getElementById("cardContainer");
  if (!cardContainer) return;
  cardContainer.addEventListener("touchstart", e => { startX = e.touches[0].clientX; }, { passive: true });
  cardContainer.addEventListener("touchend", e => { endX = e.changedTouches[0].clientX; const diff = startX - endX; if (diff > 50) nextCard(); else if (diff < -50) prevCard(); }, { passive: true });
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(c => c && c.question && c.answer).map(c => ({ question: String(c.question), answer: String(c.answer) })) : [];
  } catch { return []; }
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}
function escapeAttribute(value) { return escapeHTML(value).replace(/`/g, "&#96;"); }
function maskEmail(email) {
  const value = String(email || "");
  const parts = value.split("@");
  if (parts.length !== 2) return "";
  const name = parts[0];
  const shown = name.length <= 2 ? `${name[0] || ""}***` : `${name[0]}***${name.slice(-1)}`;
  return `${shown}@${parts[1]}`;
}

window.addEventListener("DOMContentLoaded", async () => {
  updateInstallUI();
  bindSwipe();
  updateAuthUI(null);

  const savedTheme = localStorage.getItem("theme") || "dark";
  if (savedTheme === "light") document.body.classList.add("light-mode");

  if (isHomePage()) {
    // Shared link preview can be loaded publicly; personal data loads only after auth.
    await loadSharedFromQuery();
    initAuth();
  } else {
    initAuth();
  }

  audio = document.getElementById("audioPlayer");
  if (audio) {
    audio.addEventListener("ended", () => nextMusic());
    loadSong(currentSong);
  }
});

window.toggleTheme = () => {
  document.body.classList.toggle("light-mode");
  localStorage.setItem("theme", document.body.classList.contains("light-mode") ? "light" : "dark");
};

window.onload = function () {
  if (getActiveDeck()) setQuizFromActiveDeck();
  if (document.getElementById("cardContainer") && !currentUser) {
    const legacy = safeParseArray(localStorage.getItem("quizData"));
    if (legacy.length && quiz.length === 0) quiz = legacy;
  }
  if (quiz.length > 0 && document.getElementById("cardContainer")) showReviewer();
};
