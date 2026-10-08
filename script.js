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
  equalTo,
  onDisconnect
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
let privacyData = { searchable: true, showActiveStatus: true, showEmail: true, showDeckCount: true, allowMessages: true };
let activeDirectoryRef = null;
let presenceOnline = false;

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
    const userRef = ref(rtdb, `users/${user.uid}`);
    const existing = await get(userRef);
    const firstLogin = !existing.exists() || !existing.child("welcomeEmailQueued").exists();
    await update(userRef, {
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
    return firstLogin;
  } catch (error) {
    console.error("Failed to record login:", error);
    return false;
  }
}

async function queueWelcomeEmail(user) {
  if (!user?.email) return;
  try {
    await addDoc(collection(db, "mail"), {
      uid: user.uid,
      to: user.email,
      message: {
        subject: "Welcome to WHITE_QUIZXYZ 👋",
        text: `Hi ${user.displayName || "there"}! Welcome to WHITE_QUIZXYZ. Your decks and chats are ready to sync with your Google account.`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Welcome to WHITE_QUIZXYZ 👋</h2><p>Hi ${escapeHTML(user.displayName || "there")}!</p><p>Your account is ready. Your flashcard decks can sync with your Google account, and you can use WHITEQUIZ Chat to message other learners.</p><p>Study smart. Keep growing. — WHITE</p></div>`
      },
      queuedAt: firestoreServerTimestamp()
    });
    await update(ref(rtdb, `users/${user.uid}`), { welcomeEmailQueued: serverTimestamp() });
    showChatToast("👋 Welcome! A welcome email has been queued to your Gmail.", "success");
  } catch (error) {
    console.warn("Welcome email queue unavailable:", error);
    showChatToast(`👋 Welcome to WHITE_QUIZXYZ, ${user.displayName || "friend"}!`, "success");
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
      syncDirectoryProfile().catch(()=>{});
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
      presenceOnline = false;
      if (activeDirectoryRef) { update(activeDirectoryRef, { active: false, activeAt: Date.now() }).catch(()=>{}); }
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
    const firstLogin = await recordLogin(user);
    if (firstLogin && isHomePage()) await queueWelcomeEmail(user);
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
    syncDirectoryProfile().catch(()=>{});
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
        <button class="deck-mini-more" type="button" title="Deck actions" aria-label="Deck actions" onclick="showDeckActions('${escapeAttribute(id)}', event)">⋯</button>
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

window.showDeckActions = function (id, event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!currentUser || !decks[id]) return;
  const menu = document.getElementById("deckContextMenu");
  if (!menu) return;
  menu.innerHTML = `
    <button type="button" onclick="renameDeck(event,'${escapeAttribute(id)}')">✏️ Rename</button>
    <button type="button" class="danger" onclick="deleteDeck(event,'${escapeAttribute(id)}')">🗑 Delete deck</button>
  `;
  menu.dataset.deckId = id;
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  const x = event?.clientX ?? window.innerWidth - 230;
  const y = event?.clientY ?? 120;
  menu.style.left = `${Math.max(12, Math.min(x, window.innerWidth - rect.width - 12))}px`;
  menu.style.top = `${Math.max(12, Math.min(y, window.innerHeight - rect.height - 12))}px`;
};

window.renameDeck = async function (event, id) {
  event?.preventDefault();
  event?.stopPropagation();
  document.getElementById("deckContextMenu")?.classList.add("hidden");
  if (!currentUser || !decks[id]) return;
  const current = decks[id].name || "Deck";
  const next = prompt("Rename deck:", current);
  if (next === null) return;
  const name = next.trim().slice(0, 80);
  if (!name) return alert("Deck name cannot be empty.");
  if (name === current) return;
  decks[id].name = name;
  decks[id].updatedAt = Date.now();
  if (activeDeckId === id) localStorage.setItem("activeDeckName", name);
  localCache();
  renderDecksUI();
  await saveDeckToCloud(id);
  showSyncStatus(`Renamed deck to “${name}”`, false, 1800);
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

window.deleteDeck = async function (event, id) {
  event?.preventDefault();
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
  syncDirectoryProfile().catch(()=>{});
  if (document.getElementById("cardContainer")) showReviewer();
};

// -----------------------------
// CARDS
// -----------------------------
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

// -----------------------------
// PUBLIC SHARE + IMPORT
// -----------------------------
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
    updateSharedClearButton();
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

window.updateSharedClearButton = function () {
  const input = document.getElementById("sharedLinkInput");
  const clear = document.getElementById("clearSharedBtn");
  if (!clear) return;
  clear.classList.toggle("hidden", !String(input?.value || "").trim());
};

window.clearSharedLink = function () {
  const input = document.getElementById("sharedLinkInput");
  const preview = document.getElementById("sharedPreview");
  if (input) input.value = "";
  if (preview) { preview.innerHTML = ""; preview.classList.add("hidden"); }
  sharedQuizCache = null;
  updateSharedClearButton();
  input?.focus();
};

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
    updateSharedClearButton();
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
  clearSharedLink();
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
    container.innerHTML = `<div class="empty-card-state"><div class="empty-icon">📚</div><strong>No flashcards in this deck yet.</strong><span>Add cards from Home to start studying.</span></div>`;
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

function normalizePrivacy(raw = {}) {
  return {
    searchable: raw.searchable !== false,
    showActiveStatus: raw.showActiveStatus !== false,
    showEmail: raw.showEmail !== false,
    showDeckCount: raw.showDeckCount !== false,
    allowMessages: raw.allowMessages !== false
  };
}

function publicDirectoryRecord(user, profile = profileData, privacy = privacyData) {
  const p = profile || {};
  const pr = normalizePrivacy(privacy);
  return {
    uid: user.uid,
    username: p.username || makeDefaultUsername(user),
    usernameLower: String(p.username || makeDefaultUsername(user)).toLowerCase(),
    displayName: user.displayName || "Google User",
    emailMasked: pr.showEmail ? maskEmail(user.email || "") : "",
    photoURL: user.photoURL || "",
    bio: String(p.bio || "").slice(0,160),
    deckCount: pr.showDeckCount ? Object.keys(decks || {}).length : null,
    active: pr.showActiveStatus ? !!presenceOnline : false,
    showActiveStatus: pr.showActiveStatus,
    showDeckCount: pr.showDeckCount,
    allowMessages: pr.allowMessages,
    searchable: pr.searchable,
    activeAt: pr.showActiveStatus && presenceOnline ? Date.now() : null,
    updatedAt: serverTimestamp()
  };
}

async function syncDirectoryProfile({ presenceOnly = false } = {}) {
  if (!currentUser) return;
  const record = publicDirectoryRecord(currentUser, profileData, privacyData);
  if (presenceOnly) {
    await update(ref(rtdb, `userDirectory/${currentUser.uid}`), { active: record.active, activeAt: record.activeAt, showActiveStatus: record.showActiveStatus });
    if (privacyData.searchable) await update(ref(rtdb, `searchDirectory/${currentUser.uid}`), { active: record.active, activeAt: record.activeAt, showActiveStatus: record.showActiveStatus });
    return;
  }
  await update(ref(rtdb, `userDirectory/${currentUser.uid}`), record);
  if (privacyData.searchable) await update(ref(rtdb, `searchDirectory/${currentUser.uid}`), record);
  else await remove(ref(rtdb, `searchDirectory/${currentUser.uid}`));
}

async function setPresence(user, online) {
  if (!user) return;
  presenceOnline = !!online;
  const recordRef = ref(rtdb, `userDirectory/${user.uid}`);
  activeDirectoryRef = recordRef;
  try {
    if (online) {
      await update(recordRef, { active: privacyData.showActiveStatus, activeAt: privacyData.showActiveStatus ? Date.now() : null });
      onDisconnect(recordRef).update({ active: false, activeAt: null });
      const searchPresence = onDisconnect(ref(rtdb, `searchDirectory/${user.uid}`));
      if (privacyData.searchable) {
        await update(ref(rtdb, `searchDirectory/${user.uid}`), { active: privacyData.showActiveStatus, activeAt: privacyData.showActiveStatus ? Date.now() : null });
        searchPresence.update({ active: false, activeAt: null });
      } else {
        searchPresence.cancel().catch(()=>{});
      }
    } else {
      await update(recordRef, { active: false, activeAt: Date.now() });
      await update(ref(rtdb, `searchDirectory/${user.uid}`), { active: false, activeAt: Date.now() }).catch(()=>{});
    }
  } catch (e) { console.warn("Presence update failed", e); }
}

function profileDeckCountText(target) {
  if (target?.showDeckCount === false) return "Hidden";
  const n = Number(target.deckCount || 0);
  return `${n} deck${n === 1 ? "" : "s"}`;
}

function profileActiveText(target) {
  if (target?.showActiveStatus === false) return "Active status hidden";
  return target.active ? "Active now" : "Offline";
}

async function ensureUserProfile(user) {
  if (!user) return;
  try {
    const snap=await get(ref(rtdb,`users/${user.uid}/profile`));
    if(snap.exists()) profileData=snap.val()||{};
    else { profileData={username:makeDefaultUsername(user),bio:"",createdAt:Date.now(),updatedAt:Date.now()}; await set(ref(rtdb,`users/${user.uid}/profile`),profileData); }
    privacyData=normalizePrivacy(profileData.privacy);
    profileData={...(profileData||{}),privacy:privacyData};
    await update(ref(rtdb,`users/${user.uid}/profile`),{privacy:privacyData});
    await syncDirectoryProfile();
    await setPresence(user, true);
    fillProfileUI();
    fillPrivacyUI();
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

function fillPrivacyUI(){
  const map={
    privacySearchable:privacyData.searchable,
    privacyActiveStatus:privacyData.showActiveStatus,
    privacyShowEmail:privacyData.showEmail,
    privacyShowDeckCount:privacyData.showDeckCount,
    privacyAllowMessages:privacyData.allowMessages
  };
  Object.entries(map).forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.checked=!!val;});
}

window.openPrivacySettings=function(){
  if(!currentUser)return openMandatoryAuth();
  document.getElementById("settingsCard")?.classList.add("hidden");
  fillPrivacyUI();
  document.getElementById("privacyCard")?.classList.remove("hidden");
};
window.closePrivacySettings=function(){document.getElementById("privacyCard")?.classList.add("hidden");};
window.savePrivacySettings=async function(){
  if(!currentUser)return openMandatoryAuth();
  const next=normalizePrivacy({
    searchable:document.getElementById("privacySearchable")?.checked,
    showActiveStatus:document.getElementById("privacyActiveStatus")?.checked,
    showEmail:document.getElementById("privacyShowEmail")?.checked,
    showDeckCount:document.getElementById("privacyShowDeckCount")?.checked,
    allowMessages:document.getElementById("privacyAllowMessages")?.checked
  });
  try{
    privacyData=next;
    profileData={...(profileData||{}),privacy:privacyData,updatedAt:Date.now()};
    await update(ref(rtdb,`users/${currentUser.uid}/profile`),{privacy:privacyData,updatedAt:Date.now()});
    await syncDirectoryProfile();
    await setPresence(currentUser,true);
    closePrivacySettings();
    showChatToast("🛡️ Privacy settings saved.","success");
  }catch(e){
    console.error(e);
    showChatToast("Could not save privacy settings. Check Firebase rules.","error");
  }
};

window.saveProfile=async function(){
  if(!currentUser)return openMandatoryAuth();
  const raw=slugifyUsername(document.getElementById("username")?.value||""); const bio=String(document.getElementById("bio")?.value||"").trim().slice(0,160);
  if(raw.length<3)return alert("Username must be at least 3 characters and may contain letters, numbers, and underscores.");
  try{
    const snap=await get(query(ref(rtdb,"userDirectory"),orderByChild("usernameLower"),equalTo(raw)));
    let taken=false; snap.forEach(x=>{if(x.key!==currentUser.uid)taken=true;}); if(taken)return alert("That username is already taken.");
    profileData={...(profileData||{}),username:raw,bio,privacy:privacyData,updatedAt:Date.now()};
    await update(ref(rtdb,`users/${currentUser.uid}/profile`),profileData);
    await syncDirectoryProfile();
    await setPresence(currentUser, true);
    fillProfileUI(); renderChatList(); showChatToast("✅ Profile saved.","success");
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
function normalizeChatMeta(v={},fallback=""){
  return {
    otherUid:String(v.otherUid||fallback),
    conversationId:String(v.conversationId||""),
    username:String(v.username||"user"),
    displayName:String(v.displayName||"User"),
    photoURL:String(v.photoURL||"logo.png"),
    lastMessage:String(v.lastMessage||""),
    lastMessageAt:Number(v.lastMessageAt||0),
    pinned:!!v.pinned,
    locked:!!v.locked,
    pinHash:String(v.pinHash||""),
    unread:Number(v.unread||0),
    lastMessageReadAt:Number(v.lastMessageReadAt||0)
  };
}
let activeMessages = {};
let pinModalMode = null;
let pinModalUid = null;
let pinModalReturnFocus = null;
let chatToastTimer = null;
let chatListPrevious = {};
let lastNotificationAt = {};

function showChatToast(message, kind="info"){
  const el=document.getElementById("chatToast");
  if(!el)return;
  clearTimeout(chatToastTimer);
  el.className=`chat-toast ${kind}`;
  el.textContent=message;
  el.classList.remove("hidden");
  chatToastTimer=setTimeout(()=>el.classList.add("hidden"),4200);
}

async function requestChatNotifications(){
  try{
    if("Notification" in window && Notification.permission==="default") await Notification.requestPermission();
  }catch(e){console.warn("Notification permission unavailable",e);}
}

function notifyIncomingMessage(meta, text, senderName){
  const uid=meta?.otherUid;
  const now=Date.now();
  if(uid && lastNotificationAt[uid] && now-lastNotificationAt[uid]<1200)return;
  if(uid)lastNotificationAt[uid]=now;
  const label=senderName || meta?.displayName || meta?.username || "Someone";
  showChatToast(`💬 ${label}: ${String(text||"New message").slice(0,90)}`,"message");
  try{
    if("Notification" in window && Notification.permission==="granted" && document.visibilityState!=="visible"){
      new Notification(`WHITEQUIZ • ${label}`,{body:String(text||"New message").slice(0,120),icon:"logo.png",tag:`whitequiz-chat-${uid||Date.now()}`});
    }
  }catch(e){console.warn("Browser notification failed",e);}
}

async function sha256(value){
  const data=new TextEncoder().encode(String(value));
  const hash=await crypto.subtle.digest("SHA-256",data);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

function getPinDigits(){return Array.from(document.querySelectorAll("#pinModal .pin-digit"));}
function clearPinInputs(focusFirst=true){
  const digits=getPinDigits();
  digits.forEach(i=>i.value="");
  document.getElementById("pinModalError")?.classList.add("hidden");
  if(focusFirst) digits[0]?.focus();
}
function pinValue(){return getPinDigits().map(i=>i.value).join("");}
function visibleElement(el){
  if(!(el instanceof HTMLElement) || !el.isConnected) return false;
  if(el.closest('.hidden,[aria-hidden="true"]')) return false;
  const r=el.getBoundingClientRect();
  return r.width>0 && r.height>0;
}
function getPinFallbackFocus(){
  const messageInput=document.getElementById("messageInput");
  if(visibleElement(messageInput)) return messageInput;
  const search=document.getElementById("chatUserSearch");
  if(visibleElement(search)) return search;
  const chat=document.getElementById("chatCard");
  if(visibleElement(chat)) return chat.querySelector(".close-btn") || chat;
  return document.body;
}
function openPinModal(mode,uid){
  pinModalMode=mode; pinModalUid=uid;
  const modal=document.getElementById("pinModal"), title=document.getElementById("pinModalTitle"), text=document.getElementById("pinModalText"), btn=document.getElementById("pinModalSubmit");
  if(!modal)return;
  const active=document.activeElement;
  pinModalReturnFocus=active instanceof HTMLElement && !modal.contains(active) ? active : null;
  title.textContent=mode==="set"?"Set Chat PIN":mode==="change"?"Change Chat PIN":mode==="unlockForChange"?"Verify Current PIN":mode==="unlock"?"Unlock Chat":"Chat PIN";
  text.textContent=mode==="set"?"Create a 6-digit PIN for this private conversation.":mode==="change"?"Create a new 6-digit PIN for this conversation.":mode==="unlockForChange"?"Enter your current PIN before changing it.":"Enter your 6-digit PIN to open this private conversation.";
  if(btn)btn.textContent=mode==="unlock"||mode==="unlockForChange"?"Unlock":mode==="change"?"Save New PIN":"Save PIN";
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden","false");
  modal.setAttribute("aria-modal","true");
  clearPinInputs(true);
}
window.closePinModal=function(){
  const modal=document.getElementById("pinModal");
  const active=document.activeElement;
  if(modal?.contains(active)) active.blur();
  const restore=visibleElement(pinModalReturnFocus)?pinModalReturnFocus:getPinFallbackFocus();
  if(restore && restore!==document.body) { try{ restore.focus({preventScroll:true}); }catch{ restore.focus(); } }
  modal?.classList.add("hidden");
  modal?.setAttribute("aria-hidden","true");
  modal?.setAttribute("aria-modal","false");
  pinModalMode=null;
  pinModalUid=null;
  pinModalReturnFocus=null;
  clearPinInputs(false);
};

async function submitPinModal(){
  if(!currentUser||!pinModalUid)return;
  const pin=pinValue();
  const errorBox=document.getElementById("pinModalError");
  if(!/^\d{6}$/.test(pin)){if(errorBox){errorBox.textContent="PIN must contain exactly 6 digits.";errorBox.classList.remove("hidden");}return;}
  try{
    const meta=normalizeChatMeta(chatUsers[pinModalUid],pinModalUid), cid=meta.conversationId||conversationId(currentUser.uid,pinModalUid);
    if(pinModalMode==="unlock" || pinModalMode==="unlockForChange"){
      const hash=await sha256(`${cid}::${pin}`);
      if(hash!==meta.pinHash){if(errorBox){errorBox.textContent="Incorrect PIN. Try again.";errorBox.classList.remove("hidden");}clearPinInputs();return;}
      const uid=pinModalUid;
      const mode=pinModalMode;
      closePinModal();
      if(mode==="unlockForChange") openPinModal("change",uid);
      else await openConversation(uid,true);
      return;
    }
    const hash=await sha256(`${cid}::${pin}`);
    await update(ref(rtdb,`userChats/${currentUser.uid}/${pinModalUid}`),{locked:true,pinHash:hash});
    if(pinModalMode==="set")showChatToast("🔒 Chat locked with a PIN.","success"); else showChatToast("🔐 Chat PIN updated.","success");
    closePinModal();
    renderChatList();
  }catch(e){console.error(e);if(errorBox){errorBox.textContent="Could not save the chat PIN. Check Firebase rules.";errorBox.classList.remove("hidden");}}
}

document.addEventListener("DOMContentLoaded",()=>{
  document.querySelectorAll("#pinModal .pin-digit").forEach((input,idx,all)=>{
    input.addEventListener("input",()=>{input.value=input.value.replace(/\D/g,"").slice(0,1);if(input.value&&all[idx+1])all[idx+1].focus();});
    input.addEventListener("keydown",e=>{if(e.key==="Backspace"&&!input.value&&all[idx-1]){e.preventDefault();all[idx-1].focus();}});
    input.addEventListener("paste",e=>{e.preventDefault();const v=(e.clipboardData?.getData("text")||"").replace(/\D/g,"").slice(0,6);v.split("").forEach((d,i)=>{if(all[i])all[i].value=d;});all[Math.min(v.length,5)]?.focus();});
  });
  document.getElementById("pinModalSubmit")?.addEventListener("click",submitPinModal);

  const questionInput=document.getElementById("question");
  const answerInput=document.getElementById("answer");
  questionInput?.addEventListener("keydown",e=>{
    if(e.key!=="Enter" || e.isComposing)return;
    e.preventDefault();
    answerInput?.focus();
  });
  answerInput?.addEventListener("keydown",e=>{
    if(e.key!=="Enter" || e.isComposing)return;
    e.preventDefault();
    if(answerInput.value.trim()) {
      Promise.resolve(window.addQuestion()).then(()=>questionInput?.focus()).catch(err=>console.error("Auto-save flashcard failed",err));
    }
  });

  const sharedInput=document.getElementById("sharedLinkInput");
  sharedInput?.addEventListener("input",()=>{
    updateSharedClearButton();
  });
  sharedInput?.addEventListener("keydown",e=>{
    if(e.key==="Enter" && !e.isComposing){
      e.preventDefault();
      window.loadSharedQuiz();
    }
  });
  updateSharedClearButton();

  document.addEventListener("click",()=>{
    document.getElementById("chatContextMenu")?.classList.add("hidden");
    document.getElementById("deckContextMenu")?.classList.add("hidden");
  });
});

function chatMenuPosition(x,y){
  const menu=document.getElementById("chatContextMenu"); if(!menu)return;
  menu.style.left="0px";menu.style.top="0px";menu.classList.remove("hidden");
  const rect=menu.getBoundingClientRect();
  menu.style.left=`${Math.min(x,window.innerWidth-rect.width-12)}px`;
  menu.style.top=`${Math.min(y,window.innerHeight-rect.height-12)}px`;
}

window.showChatActions=function(uid,e){
  e?.preventDefault();e?.stopPropagation(); if(!uid||!currentUser)return;
  const meta=normalizeChatMeta(chatUsers[uid],uid), menu=document.getElementById("chatContextMenu"); if(!menu)return;
  menu.innerHTML=`<button type="button" onclick="togglePinnedChat(event,'${escapeAttribute(uid)}')">${meta.pinned?'📌 Unpin chat':'📌 Pin chat'}</button><button type="button" onclick="${meta.locked?'unlockChatFromMenu':'lockChatFromMenu'}(event,'${escapeAttribute(uid)}')">${meta.locked?'🔓 Unlock chat':'🔒 Lock chat with PIN'}</button>${meta.locked?`<button type="button" onclick="changeChatPin(event,'${escapeAttribute(uid)}')">🔑 Change PIN</button>`:''}<button type="button" class="danger" onclick="deleteChatList(event,'${escapeAttribute(uid)}')">🗑 Delete chat</button>`;
  chatMenuPosition(e?.clientX||window.innerWidth-240,e?.clientY||120);
};

window.lockChatFromMenu=function(e,uid){e?.preventDefault();e?.stopPropagation();document.getElementById("chatContextMenu")?.classList.add("hidden");openPinModal("set",uid);};
window.changeChatPin=function(e,uid){e?.preventDefault();e?.stopPropagation();document.getElementById("chatContextMenu")?.classList.add("hidden");openPinModal("unlockForChange",uid);};
window.unlockChatFromMenu=async function(e,uid){e?.preventDefault();e?.stopPropagation();document.getElementById("chatContextMenu")?.classList.add("hidden");
  const meta=normalizeChatMeta(chatUsers[uid],uid); if(!meta.locked)return;
  openPinModal("unlock",uid);
};

async function deleteChatList(e,uid){
  e?.preventDefault();e?.stopPropagation();document.getElementById("chatContextMenu")?.classList.add("hidden");
  if(!currentUser||!uid)return;
  if(!confirm("Delete this chat from your chat list? The other user will keep their copy."))return;
  try{await remove(ref(rtdb,`userChats/${currentUser.uid}/${uid}`));if(activeChatUid===uid)showChatListMobile();showChatToast("🗑 Chat removed from your list.","success");}catch(err){console.error(err);showChatToast("Could not delete this chat.","error");}
}
window.deleteChatList=deleteChatList;

function attachChatLongPress(el,uid){
  let timer=null, moved=false;
  const clear=()=>{if(timer){clearTimeout(timer);timer=null;}};
  el.addEventListener("touchstart",ev=>{moved=false;clear();timer=setTimeout(()=>{moved=true;showChatActions(uid,{clientX:ev.touches[0]?.clientX||window.innerWidth/2,clientY:ev.touches[0]?.clientY||window.innerHeight/2,preventDefault(){},stopPropagation(){}});},560);},{passive:true});
  el.addEventListener("touchmove",()=>{moved=true;clear();},{passive:true});
  el.addEventListener("touchend",()=>clear(),{passive:true});
  el.addEventListener("contextmenu",ev=>{ev.preventDefault();showChatActions(uid,ev);});
}

function renderChatList(){
  const el=document.getElementById("chatList");if(!el)return;
  const rows=Object.values(chatUsers).map(normalizeChatMeta).sort((a,b)=>(Number(b.pinned)-Number(a.pinned))||(b.lastMessageAt-a.lastMessageAt));
  el.innerHTML=rows.length?rows.map(c=>`<div class="chat-user-row ${activeChatUid===c.otherUid?'active':''} ${c.locked?'chat-locked':''}" data-chat-uid="${escapeAttribute(c.otherUid)}" onclick="openConversation('${escapeAttribute(c.otherUid)}')"><img class="chat-user-avatar" src="${escapeAttribute(c.photoURL)}" alt=""><span class="chat-user-copy"><strong>@${escapeHTML(c.username)} ${c.locked?'🔒':''}</strong><small>${escapeHTML(c.lastMessage||'Start a conversation')}${c.unread>0?` • ${c.unread} unread`:''}</small></span><span class="chat-row-actions"><span class="chat-unread-dot ${c.unread>0?'show':''}"></span><button class="pin-chat-btn ${c.pinned?'pinned':''}" type="button" onclick="showChatActions('${escapeAttribute(c.otherUid)}',event)">⋯</button></span></div>`).join(""): '<div class="chat-empty-list">No conversations yet.<br>Search a username above to start one.</div>';
  el.querySelectorAll(".chat-user-row[data-chat-uid]").forEach(row=>attachChatLongPress(row,row.dataset.chatUid));
  const unread=rows.reduce((n,c)=>n+Math.max(0,c.unread),0), badge=document.getElementById("chatBadge");if(badge){badge.textContent=unread>99?'99+':unread;badge.classList.toggle('hidden',!unread);}
}

function subscribeToChatList(user){
  if(stopChatListListener)stopChatListListener();
  chatUsers={};chatListPrevious={};
  stopChatListListener=onValue(ref(rtdb,`userChats/${user.uid}`),snap=>{
    const raw=snap.val()||{};
    const next=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,normalizeChatMeta(v,k)]));
    Object.values(next).forEach(meta=>{
      const prev=chatListPrevious[meta.otherUid];
      if(prev && meta.unread>Number(prev.unread||0) && meta.otherUid!==activeChatUid){notifyIncomingMessage(meta,meta.lastMessage,meta.displayName);}
    });
    chatUsers=next;chatListPrevious=JSON.parse(JSON.stringify(next));renderChatList();
  });
}
async function getDirectoryUser(uid){const s=await get(ref(rtdb,`userDirectory/${uid}`));return s.exists()?s.val():null;}
async function ensureConversation(target){const cid=conversationId(currentUser.uid,target.uid),rr=ref(rtdb,`conversations/${cid}`),s=await get(rr);if(!s.exists())await update(rr,{members:{[currentUser.uid]:true,[target.uid]:true},createdAt:serverTimestamp()});return cid;}
window.openChat=async function(){
  if(!currentUser)return openMandatoryAuth();
  await requestChatNotifications();
  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("privacyCard")?.classList.add("hidden");
  const chatCard=document.getElementById("chatCard");
  chatCard?.classList.remove("hidden");
  chatCard?.setAttribute("aria-hidden","false");
  chatCard?.setAttribute("aria-modal","true");
  showChatListMobile();
  document.getElementById("chatUserSearch")?.focus();
};
window.closeChat=function(){
  const chatCard=document.getElementById("chatCard");
  const drawer=chatCard?.querySelector(".chat-drawer-card");
  chatCard?.classList.add("hidden");
  chatCard?.setAttribute("aria-hidden","true");
  chatCard?.removeAttribute("aria-modal");
  chatCard?.classList.remove("chat-conversation-open");
  drawer?.classList.remove("chat-conversation-open");
  activeChatUid=null;
  activeMessages={};
  if(stopMessagesListener){stopMessagesListener();stopMessagesListener=null;}
};
window.showChatListMobile=function(){
  const chatCard=document.getElementById("chatCard");
  const drawer=chatCard?.querySelector(".chat-drawer-card");
  chatCard?.classList.remove("chat-conversation-open");
  drawer?.classList.remove("chat-conversation-open");
  document.getElementById("conversationView")?.classList.add("hidden");
  document.getElementById("conversationEmpty")?.classList.remove("hidden");
  activeChatUid=null;
  activeMessages={};
  if(stopMessagesListener){stopMessagesListener();stopMessagesListener=null;}
  renderChatList();
};

function renderSearchProfile(target){
  const out=document.getElementById("searchProfileContent");
  if(!out||!target)return;
  const allow=target.allowMessages!==false;
  out.innerHTML=`
    <div class="search-profile-hero">
      <img src="${escapeAttribute(target.photoURL||'logo.png')}" alt="${escapeAttribute(target.username||'User')}" class="search-profile-avatar">
      <div class="search-profile-name"><strong>@${escapeHTML(target.username||'user')}</strong><span>${escapeHTML(target.displayName||'WHITEQUIZ user')}</span></div>
      <div class="profile-status-pill ${target.active&&target.showActiveStatus?'active':''}">${target.active&&target.showActiveStatus?'● Active now':'○ Offline'}</div>
    </div>
    <div class="search-profile-bio">${escapeHTML(target.bio||'No bio added yet.')}</div>
    <div class="search-profile-grid">
      <div><small>GMAIL</small><strong>${escapeHTML(target.emailMasked||'Hidden')}</strong></div>
      <div><small>DECKS</small><strong>${escapeHTML(profileDeckCountText(target))}</strong></div>
      <div><small>STATUS</small><strong>${escapeHTML(profileActiveText(target))}</strong></div>
    </div>
    ${allow?'<button id="previewMessageBtn" class="btn-primary btn-full" type="button">💬 Message</button>':'<div class="privacy-blocked-message">🔒 This user is not accepting new message requests right now.</div>'}
  `;
  document.getElementById("previewMessageBtn")?.addEventListener("click",()=>messageSearchedUser(target.uid));
}

window.previewSearchedUser=async function(uid){
  if(!currentUser||uid===currentUser.uid)return;
  try{
    const target=await getDirectoryUser(uid);
    if(!target)return;
    renderSearchProfile(target);
    const modal=document.getElementById("searchProfilePreview");
    modal?.classList.remove("hidden"); modal?.setAttribute("aria-hidden","false");
  }catch(e){console.error(e);showChatToast("Could not load this profile.","error");}
};
window.closeSearchProfilePreview=function(){const modal=document.getElementById("searchProfilePreview");modal?.classList.add("hidden");modal?.setAttribute("aria-hidden","true");};
window.messageSearchedUser=async function(uid){
  if(!currentUser||uid===currentUser.uid)return;
  try{
    const target=await getDirectoryUser(uid);
    if(!target)return;
    if(target.allowMessages===false){closeSearchProfilePreview();return showChatToast("This user is not accepting new message requests.","error");}
    const cid=await ensureConversation({uid,...target});
    const mine=normalizeChatMeta(chatUsers[uid],uid),p=profileData||{};
    await update(ref(rtdb),{
      [`userChats/${currentUser.uid}/${uid}`]:{otherUid:uid,conversationId:cid,username:target.username||'user',displayName:target.displayName||'User',photoURL:target.photoURL||'',lastMessage:mine.lastMessage,lastMessageAt:mine.lastMessageAt,pinned:mine.pinned,locked:mine.locked,pinHash:mine.pinHash,unread:0,updatedAt:serverTimestamp()},
      [`userChats/${uid}/${currentUser.uid}`]:{otherUid:currentUser.uid,conversationId:cid,username:p.username||makeDefaultUsername(currentUser),displayName:currentUser.displayName||'Google User',photoURL:currentUser.photoURL||'',lastMessage:mine.lastMessage,lastMessageAt:mine.lastMessageAt,pinned:false,unread:0,updatedAt:serverTimestamp()}
    });
    closeSearchProfilePreview();
    document.getElementById("chatSearchResults").innerHTML="";
    document.getElementById("chatUserSearch").value="";
    await openConversation(uid);
  }catch(e){console.error(e);showChatToast("Could not start this conversation. Check Firebase rules.","error");}
};
window.searchChatUsers=async function(){
  if(!currentUser)return;
  const term=slugifyUsername(document.getElementById("chatUserSearch")?.value||""),out=document.getElementById("chatSearchResults");
  if(!out)return;
  if(term.length<2){out.innerHTML="";return;}
  out.innerHTML='<div class="chat-search-empty">Searching…</div>';
  try{
    const snap=await get(query(ref(rtdb,"searchDirectory"),orderByChild("usernameLower"),startAt(term),endAt(term+"\uf8ff")));
    const a=[];snap.forEach(x=>{const u=x.val()||{};if(x.key!==currentUser.uid&&u.searchable!==false)a.push(u);});
    out.innerHTML=a.slice(0,12).map(u=>`<button class="chat-user-row chat-search-result" type="button" data-search-uid="${escapeAttribute(u.uid)}"><img class="chat-user-avatar" src="${escapeAttribute(u.photoURL||'logo.png')}" alt=""><span class="chat-user-copy"><strong>@${escapeHTML(u.username||'user')}</strong><small>${escapeHTML(u.displayName||'WHITEQUIZ user')} • ${escapeHTML(profileActiveText(u))}</small></span><span class="search-result-arrow">›</span></button>`).join("")||'<div class="chat-search-empty">No matching username found.</div>';
    out.querySelectorAll('[data-search-uid]').forEach(btn=>btn.addEventListener('click',()=>previewSearchedUser(btn.dataset.searchUid)));
  }catch(e){console.error(e);out.innerHTML='<div class="chat-search-empty">Search unavailable. Check your database rules.</div>';}
};

async function markIncomingMessagesRead(uid,cid,raw){
  if(!currentUser||!uid)return;
  const writes={};let lastReadAt=0;
  Object.entries(raw||{}).forEach(([mid,m])=>{
    if(m && m.senderUid===uid && !m.readAt){writes[`conversations/${cid}/messages/${mid}/readAt`]=serverTimestamp();lastReadAt=Math.max(lastReadAt,Date.now());}
  });
  if(!Object.keys(writes).length)return;
  writes[`userChats/${currentUser.uid}/${uid}/unread`]=0;
  writes[`userChats/${uid}/${currentUser.uid}/lastMessageReadAt`]=serverTimestamp();
  try{await update(ref(rtdb),writes);}catch(e){console.warn("Read receipt update failed",e);}
}

window.openConversation=async function(uid,skipLock=false){
  if(!currentUser)return openMandatoryAuth();
  const meta=normalizeChatMeta(chatUsers[uid],uid);
  if(meta.locked&&!skipLock){openPinModal("unlock",uid);return;}
  const target=await getDirectoryUser(uid);if(!target)return;
  activeChatUid=uid;
  document.getElementById("chatSearchResults")?.replaceChildren();
  document.getElementById("chatUserSearch") && (document.getElementById("chatUserSearch").value="");
  const chatCard=document.getElementById("chatCard");
  const drawer=chatCard?.querySelector(".chat-drawer-card");
  chatCard?.classList.add("chat-conversation-open");
  drawer?.classList.add("chat-conversation-open");
  chatCard?.setAttribute("aria-hidden","false");
  document.getElementById("conversationEmpty")?.classList.add("hidden");
  document.getElementById("conversationView")?.classList.remove("hidden");
  const u=document.getElementById("conversationUser");if(u)u.innerHTML=`<img src="${escapeAttribute(target.photoURL||'logo.png')}" alt=""><div><strong>@${escapeHTML(target.username||'user')}</strong><span>${escapeHTML(target.displayName||'User')} • ${escapeHTML(profileActiveText(target))} ${meta.locked?'• 🔒 Private':''}</span></div>`;
  await update(ref(rtdb,`userChats/${currentUser.uid}/${uid}`),{unread:0});
  if(stopMessagesListener)stopMessagesListener();
  const cid=meta.conversationId||conversationId(currentUser.uid,uid);
  stopMessagesListener=onValue(ref(rtdb,`conversations/${cid}/messages`),async snap=>{
    activeMessages=snap.val()||{};renderMessages(activeMessages);await markIncomingMessagesRead(uid,cid,activeMessages);
  },err=>console.error("Message listener failed",err));
  renderChatList();setTimeout(()=>document.getElementById("messageInput")?.focus(),60);
};

function messageStatus(m){
  if(!m||m.senderUid!==currentUser?.uid)return "";
  if(m.readAt)return "✓✓ Read";
  if(m.createdAt)return "✓ Sent";
  return "Sending…";
}
function renderMessages(raw){
  const list=document.getElementById("messagesList");if(!list)return;
  const rows=Object.entries(raw||{}).sort((a,b)=>Number(a[1]?.createdAt||0)-Number(b[1]?.createdAt||0));
  if(!rows.length){list.innerHTML='<div class="chat-search-empty" style="margin:auto">No messages yet. Say hello 👋</div>';return;}
  list.innerHTML=rows.map(([mid,m])=>{
    const mine=m.senderUid===currentUser?.uid,t=Number(m.createdAt||0),deleted=!!m.deleted,edited=!!m.editedAt;
    const status=messageStatus(m);
    let body;
    if(deleted){
      body='<em class="message-deleted">This message was unsent.</em>';
    }else if(m.type==="deck" && Array.isArray(m.deckCards)){
      const senderLabel = m.senderUsername || m.senderName || "WHITEQUIZ user";
      body=`<div class="chat-deck-card"><div class="chat-deck-icon">📚</div><div class="chat-deck-copy"><strong>${escapeHTML(m.deckName||"Shared Deck")}</strong><small>${m.deckCards.length} card${m.deckCards.length===1?"":"s"} • from @${escapeHTML(senderLabel)}</small></div>${mine?'<span class="chat-deck-sent">Sent</span>':`<button class="chat-deck-import-btn" type="button" onclick="importChatDeck(event,'${escapeAttribute(mid)}')">Import</button>`}</div>`;
    }else{
      body=`<p>${escapeHTML(m.text||'')}</p>`;
    }
    return `<div class="message-bubble-wrap ${mine?'mine':'theirs'}" data-message-id="${escapeAttribute(mid)}"><div class="message-bubble ${mine?'mine':'theirs'} ${deleted?'deleted':''}" ontouchstart="startMessageLongPress(event,'${escapeAttribute(mid)}')" ontouchend="cancelMessageLongPress()" oncontextmenu="showMessageActions('${escapeAttribute(mid)}',event)"><div class="message-content">${body}</div><div class="message-meta"><span class="message-time">${t?new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Sending…'}${edited&&!deleted?' • edited':''}</span>${mine?`<span class="message-status">${status}</span>`:''}</div><button class="message-more-btn" type="button" onclick="showMessageActions('${escapeAttribute(mid)}',event)">⋯</button></div></div>`;
  }).join('');
  list.scrollTop=list.scrollHeight;
}
let messagePressTimer=null;
window.startMessageLongPress=function(e,mid){clearTimeout(messagePressTimer);messagePressTimer=setTimeout(()=>showMessageActions(mid,{clientX:e.touches?.[0]?.clientX||window.innerWidth/2,clientY:e.touches?.[0]?.clientY||window.innerHeight/2,preventDefault(){},stopPropagation(){}}),560);};
window.cancelMessageLongPress=function(){clearTimeout(messagePressTimer);messagePressTimer=null;};
window.showMessageActions=function(mid,e){
  e?.preventDefault();e?.stopPropagation();clearTimeout(messagePressTimer);messagePressTimer=null;
  const m=activeMessages?.[mid];if(!m||!currentUser)return;
  const menu=document.getElementById("chatContextMenu");if(!menu)return;
  let html=m.type==="deck" ? (Array.isArray(m.deckCards) && m.senderUid!==currentUser.uid && !m.deleted ? `<button type="button" onclick="importChatDeck(event,'${escapeAttribute(mid)}')">📚 Import deck</button>` : ``) : `<button type="button" onclick="copyMessage(event,'${escapeAttribute(mid)}')">📋 Copy</button>`;
  if(m.senderUid===currentUser.uid&&!m.deleted){
    html+=m.type==="deck" ? `` : `<button type="button" onclick="editChatMessage(event,'${escapeAttribute(mid)}')">✏️ Edit message</button>`;
    html+=`<button type="button" class="danger" onclick="unsendChatMessage(event,'${escapeAttribute(mid)}')">↩ Unsend message</button>`;
  }
  menu.innerHTML=html;chatMenuPosition(e?.clientX||window.innerWidth-240,e?.clientY||120);
};
window.copyMessage=async function(e,mid){e?.stopPropagation();document.getElementById("chatContextMenu")?.classList.add("hidden");const m=activeMessages?.[mid];if(!m||m.deleted)return;try{await navigator.clipboard.writeText(m.text||"");showChatToast("📋 Message copied.","success");}catch(_){showChatToast("Could not copy the message.","error");}};
window.editChatMessage=async function(e,mid){e?.stopPropagation();document.getElementById("chatContextMenu")?.classList.add("hidden");const m=activeMessages?.[mid];if(!m||m.senderUid!==currentUser?.uid||m.deleted)return;const next=prompt("Edit your message:",m.text||"");if(next===null)return;const text=next.trim().slice(0,1000);if(!text)return alert("Message cannot be empty.");try{await update(ref(rtdb,`conversations/${conversationId(currentUser.uid,activeChatUid)}/messages/${mid}`),{text,editedAt:serverTimestamp()});await syncChatPreviewAfterMessageChange();}catch(err){console.error(err);showChatToast("Could not edit the message. Check Firebase rules.","error");}};
window.unsendChatMessage=async function(e,mid){e?.stopPropagation();document.getElementById("chatContextMenu")?.classList.add("hidden");const m=activeMessages?.[mid];if(!m||m.senderUid!==currentUser?.uid||m.deleted)return;if(!confirm("Unsend this message for everyone?"))return;try{await update(ref(rtdb,`conversations/${conversationId(currentUser.uid,activeChatUid)}/messages/${mid}`),{deleted:true,deletedAt:serverTimestamp(),text:""});await syncChatPreviewAfterMessageChange();showChatToast("↩ Message unsent.","success");}catch(err){console.error(err);showChatToast("Could not unsend the message. Check Firebase rules.","error");}};

async function syncChatPreviewAfterMessageChange(){
  if(!currentUser||!activeChatUid)return;
  const cid=conversationId(currentUser.uid,activeChatUid),snap=await get(ref(rtdb,`conversations/${cid}/messages`)),raw=snap.val()||{};
  const entries=Object.entries(raw).sort((a,b)=>Number(b[1]?.createdAt||0)-Number(a[1]?.createdAt||0));
  const latest=entries.find(([,m])=>m&&!m.deleted);
  const meta=normalizeChatMeta(chatUsers[activeChatUid],activeChatUid),target=await getDirectoryUser(activeChatUid),p=profileData||{};
  const last=latest?.[1]?.text||"Message unsent";
  const at=Number(latest?.[1]?.createdAt||Date.now());
  await update(ref(rtdb),{[`userChats/${currentUser.uid}/${activeChatUid}`]:{otherUid:activeChatUid,conversationId:cid,username:target?.username||meta.username,displayName:target?.displayName||meta.displayName,photoURL:target?.photoURL||meta.photoURL,lastMessage:last,lastMessageAt:at,pinned:meta.pinned,locked:meta.locked,pinHash:meta.pinHash,unread:0,updatedAt:serverTimestamp()},[`userChats/${activeChatUid}/${currentUser.uid}/lastMessage`]:last,[`userChats/${activeChatUid}/${currentUser.uid}/lastMessageAt`]:at});
}

let selectedSendDeckId=null;

window.openSendDeckModal=function(){
  if(!currentUser||!activeChatUid)return showChatToast("Open a conversation first.","error");
  selectedSendDeckId=null;
  const modal=document.getElementById("sendDeckModal");
  if(!modal)return;
  renderSendDeckList();
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden","false");
  modal.setAttribute("aria-modal","true");
};

window.closeSendDeckModal=function(){
  const modal=document.getElementById("sendDeckModal");
  if(modal && modal.contains(document.activeElement)) document.getElementById("messageInput")?.focus();
  modal?.classList.add("hidden");
  modal?.setAttribute("aria-hidden","true");
  modal?.removeAttribute("aria-modal");
  selectedSendDeckId=null;
};

function renderSendDeckList(){
  const out=document.getElementById("sendDeckList"),btn=document.getElementById("confirmSendDeckBtn");
  if(!out)return;
  const entries=Object.entries(decks||{});
  if(!entries.length){
    out.innerHTML='<div class="send-deck-empty">No saved decks yet. Create a deck first.</div>';
    if(btn)btn.disabled=true;
    return;
  }
  out.innerHTML=entries.map(([id,d])=>`<button type="button" class="send-deck-option ${id===selectedSendDeckId?'selected':''}" data-send-deck-id="${escapeAttribute(id)}"><span class="send-deck-option-icon">📚</span><span class="send-deck-option-copy"><strong>${escapeHTML(d.name||"Deck")}</strong><small>${d.cards.length} card${d.cards.length===1?"":"s"}</small></span><span class="send-deck-check">${id===selectedSendDeckId?'✓':''}</span></button>`).join('');
  out.querySelectorAll('[data-send-deck-id]').forEach(el=>el.addEventListener('click',()=>{
    selectedSendDeckId=el.dataset.sendDeckId||null;
    renderSendDeckList();
  }));
  if(btn){btn.disabled=!selectedSendDeckId||!decks[selectedSendDeckId]||decks[selectedSendDeckId].cards.length===0;}
}

window.sendSelectedDeck=async function(){
  if(!currentUser||!activeChatUid||!selectedSendDeckId||!decks[selectedSendDeckId])return;
  const deck=decks[selectedSendDeckId];
  if(!Array.isArray(deck.cards)||!deck.cards.length)return showChatToast("That deck has no cards to send.","error");
  const modal=document.getElementById("sendDeckModal"),btn=document.getElementById("confirmSendDeckBtn");
  if(btn){btn.disabled=true;btn.textContent="Sending…";}
  try{
    const target=await getDirectoryUser(activeChatUid);if(!target)throw new Error("Recipient not found");
    const cid=conversationId(currentUser.uid,activeChatUid);await ensureConversation({uid:activeChatUid,...target});
    const msgRef=push(ref(rtdb,`conversations/${cid}/messages`));
    const cards=deck.cards.map(c=>({question:String(c.question||""),answer:String(c.answer||"")}));
    const text=`📚 Shared deck: ${deck.name}`;
    await set(msgRef,{senderUid:currentUser.uid,senderName:currentUser.displayName||"Google User",senderUsername:profileData?.username||makeDefaultUsername(currentUser),text,createdAt:serverTimestamp(),readAt:null,deleted:false,type:"deck",deckId:selectedSendDeckId,deckName:String(deck.name||"Deck").slice(0,80),deckCards:cards});
    const old=normalizeChatMeta(chatUsers[activeChatUid],activeChatUid),p=profileData||{},sent=Date.now();
    await update(ref(rtdb),{
      [`userChats/${currentUser.uid}/${activeChatUid}`]:{otherUid:activeChatUid,conversationId:cid,username:target.username||"user",displayName:target.displayName||"User",photoURL:target.photoURL||"",lastMessage:text,lastMessageAt:sent,pinned:old.pinned,locked:old.locked,pinHash:old.pinHash,unread:0,updatedAt:serverTimestamp()},
      [`userChats/${activeChatUid}/${currentUser.uid}`]:{otherUid:currentUser.uid,conversationId:cid,username:p.username||makeDefaultUsername(currentUser),displayName:currentUser.displayName||"Google User",photoURL:currentUser.photoURL||"",lastMessage:text,lastMessageAt:sent,pinned:normalizeChatMeta(chatUsers[activeChatUid],activeChatUid).pinned||false,unread:Number(normalizeChatMeta(chatUsers[activeChatUid],activeChatUid).unread||0)+1,updatedAt:serverTimestamp()}
    });
    closeSendDeckModal();
    await requestChatNotifications();
    showChatToast(`📚 “${deck.name}” sent.`,"success");
  }catch(err){
    console.error(err);
    showChatToast("Deck could not be sent. Check Firebase rules.","error");
    if(btn){btn.disabled=false;btn.textContent="📚 Send Selected Deck";}
  }
};

window.importChatDeck=async function(e,mid){
  e?.preventDefault();e?.stopPropagation();
  const m=activeMessages?.[mid];
  if(!currentUser||!m||m.deleted||m.type!=="deck"||!Array.isArray(m.deckCards)||!m.deckCards.length)return;
  const source=m.deckName||"Shared Deck";
  let name=source;
  const tag=` (from ${m.senderUsername||m.senderName||"user"})`;
  if(name.length+tag.length<=80)name+=tag;
  else name=name.slice(0,Math.max(1,80-tag.length))+tag;
  const deckId=createDeckId();
  decks[deckId]={name,cards:m.deckCards.map(c=>({question:String(c.question||""),answer:String(c.answer||"")})),createdAt:Date.now(),updatedAt:Date.now()};
  activeDeckId=deckId;
  setActiveDeckLocal(deckId);
  setQuizFromActiveDeck();
  renderDecksUI();
  await saveDeckToCloud(deckId);
  showChatToast(`📚 “${source}” imported to My Decks.`,"success");
};

window.sendChatMessage=async function(e){
  e?.preventDefault();if(!currentUser||!activeChatUid)return;
  const inp=document.getElementById("messageInput"),text=String(inp?.value||'').trim();if(!text)return;
  try{
    const target=await getDirectoryUser(activeChatUid);if(!target)return;
    const cid=conversationId(currentUser.uid,activeChatUid);await ensureConversation({uid:activeChatUid,...target});
    const msgRef=push(ref(rtdb,`conversations/${cid}/messages`));
    await set(msgRef,{senderUid:currentUser.uid,senderName:profileData?.username||currentUser.displayName||'Google User',text:text.slice(0,1000),createdAt:serverTimestamp(),readAt:null,deleted:false});
    const old=normalizeChatMeta(chatUsers[activeChatUid],activeChatUid),p=profileData||{},sent=Date.now();
    await update(ref(rtdb),{
      [`userChats/${currentUser.uid}/${activeChatUid}`]:{otherUid:activeChatUid,conversationId:cid,username:target.username||'user',displayName:target.displayName||'User',photoURL:target.photoURL||'',lastMessage:text,lastMessageAt:sent,pinned:old.pinned,locked:old.locked,pinHash:old.pinHash,unread:0,updatedAt:serverTimestamp()},
      [`userChats/${activeChatUid}/${currentUser.uid}`]:{otherUid:currentUser.uid,conversationId:cid,username:p.username||makeDefaultUsername(currentUser),displayName:currentUser.displayName||'Google User',photoURL:currentUser.photoURL||'',lastMessage:text,lastMessageAt:sent,pinned:normalizeChatMeta(chatUsers[activeChatUid],activeChatUid).pinned||false,unread:Number(normalizeChatMeta(chatUsers[activeChatUid],activeChatUid).unread||0)+1,updatedAt:serverTimestamp()}
    });
    await requestChatNotifications();
    if(inp)inp.value='';
  }catch(err){console.error(err);showChatToast('Message could not be sent. Check Firebase rules.','error');}
};
window.togglePinnedChat=async function(e,uid){e?.preventDefault();e?.stopPropagation();const m=normalizeChatMeta(chatUsers[uid],uid);try{await update(ref(rtdb,`userChats/${currentUser.uid}/${uid}`),{pinned:!m.pinned});document.getElementById("chatContextMenu")?.classList.add("hidden");showChatToast(m.pinned?"📍 Chat unpinned.":"📌 Chat pinned.","success");}catch(err){console.error(err);showChatToast("Could not change pin state.","error");}};

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
