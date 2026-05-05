import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, addDoc, doc, getDoc } 
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDXlfkDKzeBAkXCWSg3G1914XXC1XN2AAg",
  authDomain: "whitequiz-24288.firebaseapp.com",
  projectId: "whitequiz-24288",
  storageBucket: "whitequiz-24288.firebasestorage.app",
  messagingSenderId: "852892167245",
  appId: "1:852892167245:web:43afff0a3390c475bec004"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let quiz = [];
let currentIndex = 0;
let audio;

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
window.deleteQuestion = function(index) {
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

  } catch(e) {
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
    } catch(e) {
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
        ${item.question}
        <button class="delete-btn" onclick="deleteCurrentCard(event)">✖</button>
      </div>
      <div class="back">
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
window.openProfile = function () {
  document.getElementById("settingsCard")?.classList.add("hidden");
  document.getElementById("profileCard")?.classList.remove("hidden");

  document.getElementById("username").value = localStorage.getItem("username") || "";
  document.getElementById("email").value = localStorage.getItem("email") || "";
  document.getElementById("bio").value = localStorage.getItem("bio") || "";
};

window.saveProfile = function () {
  localStorage.setItem("username", document.getElementById("username").value);
  localStorage.setItem("email", document.getElementById("email").value);
  localStorage.setItem("bio", document.getElementById("bio").value);

  alert("Profile Saved!");
};

window.backToSettings = function () {
  document.getElementById("profileCard")?.classList.add("hidden");
  document.getElementById("musicCard")?.classList.add("hidden"); // 🔥 IMPORTANT
  document.getElementById("aboutadminCard")?.classList.add("hidden"); // safety

  document.getElementById("settingsCard")?.classList.remove("hidden");
};

// MUSIC
let playlist = ["music1.mp3","music2.mp3","music3.mp3","music4.mp3","music5.mp3","music6.mp3"];
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