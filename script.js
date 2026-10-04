import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, addDoc, doc, getDoc }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  push,
  serverTimestamp
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

let quiz = [];
let currentIndex = 0;
let audio;

// MULTIPLE CHOICE STATE
let mcIndex = 0;
let mcQuestions = [];
let mcSelected = null;

// GOOGLE AUTH + PWA STATE
let currentUser = null;
let deferredInstallPrompt = null;

// -----------------------------
// GOOGLE LOGIN / USER TRACKING
// -----------------------------
async function initAuth() {
  try {
    await setPersistence(auth, browserSessionPersistence);
  } catch (error) {
    console.warn("Auth persistence setup failed:", error);
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;
    updateAuthUI(user);

    if (!user) return;

    const sessionKey = `whitequiz-login-recorded-${user.uid}`;
    if (sessionStorage.getItem(sessionKey)) return;

    try {
      await set(ref(rtdb, `users/${user.uid}`), {
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

      sessionStorage.setItem(sessionKey, "1");
    } catch (error) {
      console.error("Failed to record login:", error);
    }
  });

  try {
    await getRedirectResult(auth);
  } catch (error) {
    console.error("Google redirect sign-in error:", error);
    showAuthMessage(getAuthErrorMessage(error), true);
  }
}

function getAuthErrorMessage(error) {
  const code = error?.code || "";
  const messages = {
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/popup-blocked": "The browser blocked the sign-in window. Trying redirect sign-in instead...",
    "auth/unauthorized-domain": "Add this website domain to Firebase Authentication → Settings → Authorized domains.",
    "auth/cancelled-popup-request": "Only one Google sign-in request can run at a time."
  };
  return messages[code] || error?.message || "Google sign-in failed. Please try again.";
}

function updateAuthUI(user) {
  const loginModal = document.getElementById("mandatoryAuthModal");
  const addCardPanel = document.getElementById("addCardPanel");
  const authUserBox = document.getElementById("authUserBox");

  if (loginModal) loginModal.classList.toggle("hidden", !!user);

  // Keep Add New Card visible behind the mandatory sign-in overlay.
  // It becomes fully usable only after Google authentication succeeds.
  if (addCardPanel) {
    addCardPanel.classList.remove("hidden");
    addCardPanel.classList.toggle("auth-locked-preview", !user);
  }

  document.body.classList.toggle("auth-locked", !user);

  if (authUserBox) {
    if (user) {
      const safeName = user.displayName || "Google User";
      authUserBox.innerHTML = `
        <img src="${user.photoURL || 'logo.png'}" alt="Google profile" class="auth-avatar">
        <div class="auth-user-copy">
          <strong>${safeName}</strong>
          <span>${user.email || ""}</span>
        </div>
        <button class="auth-signout-btn" type="button" onclick="logoutGoogle()">Sign out</button>
      `;
      authUserBox.classList.remove("hidden");
    } else {
      authUserBox.classList.add("hidden");
      authUserBox.innerHTML = "";
    }
  }
}

function showAuthMessage(message, isError = false) {
  const box = document.getElementById("authMessage");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("error", isError);
  box.classList.remove("hidden");
}

function openMandatoryAuth() {
  const modal = document.getElementById("mandatoryAuthModal");
  if (!modal || currentUser) return;
  modal.classList.remove("hidden");
  document.body.classList.add("auth-locked");
}

function closeMandatoryAuth() {
  const modal = document.getElementById("mandatoryAuthModal");
  if (!modal) return;
  modal.classList.add("hidden");
  document.body.classList.remove("auth-locked");
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
    showAuthMessage("Signed in successfully.");
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
    showAuthMessage("Signed out. Sign in again to add flashcards.");
  } catch (error) {
    console.error(error);
    showAuthMessage("Could not sign out. Please try again.", true);
  }
};

// -----------------------------
// PWA INSTALL
// -----------------------------
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallUI() {
  const items = document.querySelectorAll("[data-install-app]");
  const installed = isStandalone();
  items.forEach(item => {
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
  if (isStandalone()) {
    showInstallInfo("WHITE_QUIZXYZ is already installed on this device.");
    return;
  }

  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice?.outcome === "accepted") {
      showInstallInfo("Installed! You can now open WHITE_QUIZXYZ from your home screen.");
    }
    deferredInstallPrompt = null;
    updateInstallUI();
    return;
  }

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS) {
    showInstallInfo("On iPhone/iPad: tap Share (□↑) → Add to Home Screen.");
  } else {
    showInstallInfo("Use your browser menu → Install app / Add to Home screen. The option appears after the site is fully loaded over HTTPS.");
  }
};

function showInstallInfo(message) {
  const box = document.getElementById("installInfo");
  const text = document.getElementById("installInfoText");
  if (!box || !text) return;
  text.textContent = message;
  box.classList.remove("hidden");
}

window.closeInstallInfo = function () {
  document.getElementById("installInfo")?.classList.add("hidden");
};

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallUI();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallUI();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  updateInstallUI();
  initAuth();
});

// LOAD LOCAL DATA
if (localStorage.getItem("quizData")) {
  quiz = JSON.parse(localStorage.getItem("quizData"));
}

// THEME
const body = document.body;
const savedTheme = localStorage.getItem("theme") || "dark";
if (savedTheme === "light") body.classList.add("light-mode");

window.toggleTheme = () => {
  body.classList.toggle("light-mode");
  localStorage.setItem("theme", body.classList.contains("light-mode") ? "light" : "dark");
};

// ADD QUESTION
window.addQuestion = function () {
  if (!currentUser) {
    openMandatoryAuth();
    showAuthMessage("Please sign in with Google before adding flashcards.", true);
    return;
  }

  let q = document.getElementById("question").value.trim();
  let a = document.getElementById("answer").value.trim();

  if (!q || !a) return alert("Fill all fields!");

  quiz.push({ question: q, answer: a });
  localStorage.setItem("quizData", JSON.stringify(quiz));

  document.getElementById("question").value = "";
  document.getElementById("answer").value = "";

  showReviewer();
};

// DELETE
window.deleteQuestion = function (index) {
  if (!confirm("Delete this question?")) return;

  quiz.splice(index, 1);
  localStorage.setItem("quizData", JSON.stringify(quiz));
  showReviewer();
};

// 🔥 SHARE (FIXED)
window.saveQuizOnline = async function () {
  if (quiz.length === 0) return alert("No questions!");

  try {
    let docRef = await addDoc(collection(db, "quizzes"), { data: quiz });

    let link = window.location.origin + window.location.pathname + "?quiz=" + docRef.id;

    navigator.clipboard.writeText(link); // auto copy
    alert("✅ Link copied!🔗");

  } catch (e) {
    console.error(e);
    alert("Error saving quiz");
  }
};

// LOAD PAGE (FIXED - ONE ONLY)
window.onload = async function () {

  // AUDIO SAFE INIT
  audio = document.getElementById("audioPlayer");
  if (audio) {
    audio.addEventListener("ended", function () {
      nextMusic();
    });
    loadSong(currentSong);
  }

  window.openMusic = function () {
    document.getElementById("settingsCard")?.classList.add("hidden");
    document.getElementById("musicCard")?.classList.remove("hidden");

    if (audio && !audio.src) {
      loadSong(currentSong);
    }
  };


  // LOAD SHARED QUIZ
  const params = new URLSearchParams(window.location.search);
  const id = params.get("quiz");

  if (id) {
    try {
      let snap = await getDoc(doc(db, "quizzes", id));
      if (snap.exists()) {
        quiz = snap.data().data;
        localStorage.setItem("quizData", JSON.stringify(quiz));
        alert("Shared Quiz Loaded!");
      }
    } catch (e) {
      console.error(e);
    }
  }

  if (quiz.length > 0) showReviewer();
};

// SHOW REVIEWER (SAFE)
window.showReviewer = function () {
  const reviewer = document.getElementById("reviewer");
  if (reviewer) reviewer.classList.remove("hidden");

  currentIndex = 0;
  renderCard();
};

function renderCard() {
  const container = document.getElementById("cardContainer");
  const counter = document.getElementById("counter");

  if (!container || !counter) return;

  container.innerHTML = "";

  if (quiz.length === 0) {
    container.innerHTML = "<p>No flashcards yet.</p>";
    counter.innerText = "0 / 0";
    return;
  }

  const item = quiz[currentIndex];

  const card = document.createElement("div");
  card.className = "card";

  card.innerHTML = `
    <div class="inner">
      <div class="front">
      <p class="questiontag" >Question:</p>
        ${item.question}
        <button class="delete-btn" onclick="deleteCurrentCard(event)">✖</button>
      </div>
      <div class="back"> <p class="answer" >Answer:</p>
        ${item.answer}
        <button class="delete-btn" onclick="deleteCurrentCard(event)">✖</button>
      </div>
    </div>
  `;

  card.onclick = () => card.classList.toggle("flip");

  container.appendChild(card);

  counter.innerText = `${currentIndex + 1} / ${quiz.length}`;
}

// NAVIGATION
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

window.shuffleCards = function () {

  if (quiz.length <= 1) {
    alert("Not enough cards to shuffle!");
    return;
  }

  // Fisher-Yates Shuffle
  for (let i = quiz.length - 1; i > 0; i--) {

    let j = Math.floor(Math.random() * (i + 1));

    [quiz[i], quiz[j]] = [quiz[j], quiz[i]];
  }

  // save shuffled order
  localStorage.setItem("quizData", JSON.stringify(quiz));

  // reset to first card
  currentIndex = 0;

  // rerender
  renderCard();

  alert("🔀 Cards Shuffled!");
};

// DELETE CURRENT CARD
window.deleteCurrentCard = function (event) {
  event.stopPropagation();

  if (!confirm("Delete this card?")) return;

  quiz.splice(currentIndex, 1);
  localStorage.setItem("quizData", JSON.stringify(quiz));

  if (currentIndex >= quiz.length) currentIndex = quiz.length - 1;
  if (currentIndex < 0) currentIndex = 0;

  renderCard();
};

// MULTIPLE CHOICE
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

    // Pick up to 3 different answers from the existing flashcards.
    const distractors = shuffleArray([...new Set(otherAnswers)]).slice(0, 3);

    const choices = [correctAnswer, ...distractors].map((text) => ({
      text,
      correct: text === correctAnswer
    }));

    return {
      question: item.question,
      answer: correctAnswer,
      choices: shuffleArray(choices)
    };
  });
}

function shuffleArray(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
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
    questionCard.innerHTML = `
      <span class="mc-question-tag">QUESTION</span>
      <div class="mc-question-text">No flashcards available.</div>
    `;
    choicesContainer.innerHTML = `
      <div class="mc-empty-state">Add at least 4 flashcards to create A, B, C, D choices from your saved answers.</div>
    `;
    feedback.classList.add("hidden");
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  // Rebuild in case quiz data changed while the panel was closed.
  if (mcQuestions.length !== quiz.length) buildMultipleChoiceSet();

  // With fewer than 4 unique answers, there cannot be four distinct choices.
  const uniqueAnswers = new Set(quiz.map(item => item.answer).filter(Boolean));
  if (uniqueAnswers.size < 4) {
    counter.innerText = `${mcIndex + 1} / ${quiz.length}`;
    const current = quiz[Math.min(mcIndex, quiz.length - 1)];
    questionCard.innerHTML = `
      <span class="mc-question-tag">QUESTION</span>
      <div class="mc-question-text">${current.question}</div>
    `;
    choicesContainer.innerHTML = `
      <div class="mc-empty-state">
        Need <strong>4 different answers</strong> to build A, B, C, D choices.
        <br><span>Add more flashcards with different answers.</span>
      </div>
    `;
    feedback.classList.add("hidden");
    if (prevBtn) prevBtn.disabled = mcIndex === 0;
    if (nextBtn) nextBtn.disabled = mcIndex === quiz.length - 1;
    return;
  }

  const current = mcQuestions[mcIndex];
  counter.innerText = `${mcIndex + 1} / ${mcQuestions.length}`;
  mcSelected = null;

  questionCard.innerHTML = `
    <span class="mc-question-tag">QUESTION ${mcIndex + 1}</span>
    <div class="mc-question-text">${current.question}</div>
    <span class="mc-question-footer">Select the best answer below</span>
  `;

  choicesContainer.innerHTML = "";
  const letters = ["A", "B", "C", "D"];

  current.choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mc-choice-card";
    button.innerHTML = `
      <span class="mc-choice-letter">${letters[index]}</span>
      <span class="mc-choice-text">${choice.text}</span>
    `;
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
    nextBtn.disabled = mcIndex === mcQuestions.length - 1;
    nextBtn.style.opacity = mcIndex === mcQuestions.length - 1 ? "0.45" : "1";
  }
}

window.selectMultipleChoice = function (selectedIndex) {
  if (!mcQuestions.length) return;

  const current = mcQuestions[mcIndex];
  const buttons = [...document.querySelectorAll(".mc-choice-card")];
  const feedback = document.getElementById("mcFeedback");
  if (!feedback || !buttons[selectedIndex]) return;

  // Prevent changing the answer after the result has been shown.
  if (mcSelected !== null) return;
  mcSelected = selectedIndex;

  buttons.forEach((button, index) => {
    button.disabled = true;
    if (current.choices[index].correct) {
      button.classList.add("correct");
    }
    if (index === selectedIndex && !current.choices[index].correct) {
      button.classList.add("wrong");
    }
  });

  feedback.classList.remove("hidden");

  if (current.choices[selectedIndex].correct) {
    feedback.classList.add("success");
    feedback.innerHTML = `<strong>✓ Correct!</strong> Great job.`;
  } else {
    feedback.classList.add("error");
    feedback.innerHTML = `<strong>✕ Not quite.</strong> Correct answer: <b>${current.answer}</b>`;
  }
};

window.nextMultipleChoice = function () {
  if (mcIndex < mcQuestions.length - 1) {
    mcIndex++;
    renderMultipleChoice();
  }
};

window.prevMultipleChoice = function () {
  if (mcIndex > 0) {
    mcIndex--;
    renderMultipleChoice();
  }
};

window.shuffleMultipleChoice = function () {
  if (quiz.length < 4) {
    alert("Add at least 4 different answers first.");
    return;
  }

  mcQuestions = shuffleArray(
    mcQuestions.map(item => ({
      ...item,
      choices: shuffleArray(item.choices)
    }))
  );
  mcIndex = 0;
  renderMultipleChoice();
};

// SETTINGS
window.toggleSettings = function () {
  const card = document.getElementById("settingsCard");
  if (card) card.classList.toggle("hidden");
};

document.addEventListener("click", function (e) {
  const card = document.getElementById("settingsCard");
  const btn = document.getElementById("settingsBtn");

  if (card && btn && !card.contains(e.target) && !btn.contains(e.target)) {
    card.classList.add("hidden");
  }
});

// PROFILE
// QUESTIONS & ANSWERS
window.openQA = function () {

  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("qaCard")?.classList.remove("hidden");

  renderQA();
};

function renderQA() {

  const container = document.getElementById("qaContainer");

  if (!container) return;

  container.innerHTML = "";

  if (quiz.length === 0) {

    container.innerHTML = `
      <div class="qa-item">
        <div class="qa-question">
          No flashcards available.
        </div>
      </div>
    `;

    return;
  }

  quiz.forEach((item, index) => {

    const div = document.createElement("div");

    div.className = "qa-item";

    div.innerHTML = `
      <div class="qa-question"> Q
        ${index + 1}. ${item.question}
      </div>

      <div class="qa-answer"> Answer:
        ${item.answer}
      </div>
    `;

    div.addEventListener("click", () => {

      div.classList.toggle("active");

    });

    container.appendChild(div);

  });

}

window.saveProfile = function () {
  localStorage.setItem("username", document.getElementById("username").value);
  localStorage.setItem("email", document.getElementById("email").value);
  localStorage.setItem("bio", document.getElementById("bio").value);

  alert("Profile Saved!");
};

window.backToSettings = function () {
  document.getElementById("qaCard")?.classList.add("hidden");
  document.getElementById("multipleChoiceCard")?.classList.add("hidden");
  document.getElementById("musicCard")?.classList.add("hidden"); // 🔥 IMPORTANT
  document.getElementById("aboutadminCard")?.classList.add("hidden"); // safety

  document.getElementById("settingsCard")?.classList.remove("hidden");
};

// MUSIC
let playlist = ["music1.mp3", "music2.mp3", "music3.mp3", "music4.mp3", "music5.mp3", "music6.mp3", "music7.mp3", "music8.mp3", "music9.mp3", "music10.mp3", "music11.mp3", "music12.mp3"];
let currentSong = 0;

function loadSong(index) {
  if (!audio) return;

  audio.src = playlist[index];
  document.getElementById("musicTitle").innerText = playlist[index];
}

window.togglePlay = function () {
  if (!audio) return;
  audio.paused ? audio.play() : audio.pause();
};

window.nextMusic = function () {
  currentSong = (currentSong + 1) % playlist.length;
  loadSong(currentSong);
  audio.play();
};

window.prevMusic = function () {
  currentSong = (currentSong - 1 + playlist.length) % playlist.length;
  loadSong(currentSong);
  audio.play();
};

// ABOUT
window.openAbout = function () {
  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("aboutadminCard")?.classList.remove("hidden");
};

// 📱 SWIPE FLASHCARD
let startX = 0;
let endX = 0;

const cardContainer = document.getElementById("cardContainer");

if (cardContainer) {

  cardContainer.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
  });

  cardContainer.addEventListener("touchend", (e) => {
    endX = e.changedTouches[0].clientX;

    handleSwipe();
  });

}

function handleSwipe() {

  let diff = startX - endX;

  // 👉 Swipe Left = Next
  if (diff > 50) {
    nextCard();
  }

  // 👈 Swipe Right = Previous
  else if (diff < -50) {
    prevCard();
  }

}


// 🔥 DELETE ALL CARDS
window.deleteAllCards = function () {

  if (quiz.length === 0) {
    alert("No cards to delete!");
    return;
  }

  if (!confirm("Are you sure you want to delete ALL flashcards?")) return;

  // clear array
  quiz = [];

  // remove localStorage
  localStorage.removeItem("quizData");

  // reset index
  currentIndex = 0;

  // rerender
  renderCard();

  alert("🗑 All flashcards deleted!");
};