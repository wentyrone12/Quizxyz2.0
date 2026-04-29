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

// LOAD FROM localStorage
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

// SAVE ONLINE
window.saveQuizOnline = async function () {
  if (quiz.length === 0) return alert("No questions!");
  try {
    let docRef = await addDoc(collection(db, "quizzes"), { data: quiz });
    let link = window.location.origin + window.location.pathname + "?quiz=" + docRef.id;
    prompt("Copy your quiz link:", link);
  } catch(e) { console.error(e); alert("Error saving quiz"); }
};

// LOAD SHARED QUIZ
window.onload = async function () {
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
    } catch(e) { console.error(e); }
  }
  if (quiz.length > 0) showReviewer();
};
let currentIndex = 0;

window.showReviewer = function () {
  document.getElementById("reviewer").classList.remove("hidden");

  currentIndex = 0; // reset kapag open

  renderCard();
};

function renderCard() {
  const container = document.getElementById("cardContainer");
  container.innerHTML = "";

  if (quiz.length === 0) {
    container.innerHTML = "<p>No flashcards yet.</p>";
    document.getElementById("counter").innerText = "0 / 0";
    return;
  }

  const item = quiz[currentIndex];

  const card = document.createElement("div");
  card.className = "card";

  card.innerHTML = `
    <div class="inner">

      <!-- FRONT -->
      <div class="front">
        ${item.question}
        <button class="delete-btn" onclick="deleteCurrentCard(event)">✖</button>
      </div>

      <!-- BACK -->
      <div class="back">
        ${item.answer}
        <button class="delete-btn" onclick="deleteCurrentCard(event)">✖</button>
      </div>

    </div>
  `;

  card.onclick = () => card.classList.toggle("flip");

  container.appendChild(card);

  updateCounter();
}
// SUBMIT
window.submitExam = function () {
  let score = 0;
  quiz.forEach((item, index) => {
    const ans = document.getElementById("ans"+index).value.trim();
    if (ans.toLowerCase() === item.answer.toLowerCase()) score++;
  });
  document.getElementById("score").innerText = `Score: ${score} / ${quiz.length}`;
};

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

function updateCounter() {
  document.getElementById("counter").innerText =
    `${currentIndex + 1} / ${quiz.length}`;
};

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

window.deleteCurrentCard = function (event) {
  event.stopPropagation(); // para hindi mag flip pag pinindot delete

  if (!confirm("Delete this card?")) return;

  quiz.splice(currentIndex, 1);
  localStorage.setItem("quizData", JSON.stringify(quiz));

  // adjust index
  if (currentIndex >= quiz.length) {
    currentIndex = quiz.length - 1;
  }

  if (currentIndex < 0) currentIndex = 0;

  renderCard();
};
function saveDecks() {
  localStorage.setItem("decks", JSON.stringify(decks));
  localStorage.setItem("currentDeck", currentDeck);
}
window.createDeck = function () {
  const name = document.getElementById("deckName").value.trim();
  if (!name) return alert("Enter deck name!");

  if (decks[name]) return alert("Deck already exists!");

  decks[name] = [];
  currentDeck = name;

  saveDecks();
  updateDeckList();
  alert("Deck created!");
};
window.switchDeck = function () {
  const select = document.getElementById("deckList");
  currentDeck = select.value;

  saveDecks();
  renderCard();
};
window.deleteDeck = function () {
  if (!currentDeck) return;

  if (!confirm("Delete this deck?")) return;

  delete decks[currentDeck];
  currentDeck = null;

  saveDecks();
  updateDeckList();
  document.getElementById("cardContainer").innerHTML = "";
};
function updateDeckList() {
  const select = document.getElementById("deckList");
  select.innerHTML = "";

  Object.keys(decks).forEach(deck => {
    const option = document.createElement("option");
    option.value = deck;
    option.textContent = deck;
    if (deck === currentDeck) option.selected = true;
    select.appendChild(option);
  });
}

window.shuffleCards = function () {
  if (quiz.length === 0) return;

  // Fisher-Yates Shuffle Algorithm
  for (let i = quiz.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [quiz[i], quiz[j]] = [quiz[j], quiz[i]];
  }

  // reset index after shuffle
  currentIndex = 0;

  // rerender card
  renderCard();

  alert("Cards shuffled! 🔀");
};

window.toggleSettings = function () {
  const card = document.getElementById("settingsCard");
  card.classList.toggle("hidden");
};

document.addEventListener("click", function (e) {
  const card = document.getElementById("settingsCard");
  const btn = document.getElementById("settingsBtn");

  if (!card.contains(e.target) && !btn.contains(e.target)) {
    card.classList.add("hidden");
  }
});

// OPEN PROFILE
window.openProfile = function () {
  document.getElementById("settingsCard").classList.add("hidden");
  document.getElementById("profileCard").classList.remove("hidden");

  // load saved data
  document.getElementById("username").value = localStorage.getItem("username") || "";
  document.getElementById("email").value = localStorage.getItem("email") || "";
  document.getElementById("bio").value = localStorage.getItem("bio") || "";
};

// SAVE PROFILE
window.saveProfile = function () {
  localStorage.setItem("username", document.getElementById("username").value);
  localStorage.setItem("email", document.getElementById("email").value);
  localStorage.setItem("bio", document.getElementById("bio").value);

  alert("Profile Saved!");
};

// OPEN MUSIC
let isPlaying = false;

window.openMusic = function () {
  document.getElementById("settingsCard").classList.add("hidden");
  document.getElementById("musicCard").classList.remove("hidden");
};

// BACK TO SETTINGS
window.backToSettings = function () {
  document.getElementById("profileCard").classList.add("hidden");
  document.getElementById("musicCard").classList.add("hidden");
  document.getElementById("settingsCard").classList.remove("hidden");
};

let playlist = [
  "music1.mp3",
  "music2.mp3",
  "music3.mp3",
  "music4.mp3",
  "music5.mp3",
  "music6.mp3"
];

let currentSong = 0;
let audio = document.getElementById("audioPlayer");

// LOAD SONG
function loadSong(index) {
  audio.src = playlist[index];

  let name = playlist[index].split("/").pop();
  document.getElementById("musicTitle").innerText = name;
}

// OPEN MUSIC
window.openMusic = function () {
  document.getElementById("settingsCard").classList.add("hidden");
  document.getElementById("musicCard").classList.remove("hidden");

  if (!audio.src) {
    loadSong(currentSong);
  }
};

// PLAY / PAUSE
window.togglePlay = function () {
  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
};

// NEXT
window.nextMusic = function () {
  currentSong++;
  if (currentSong >= playlist.length) currentSong = 0;

  loadSong(currentSong);
  audio.play();
};

// PREVIOUS
window.prevMusic = function () {
  currentSong--;
  if (currentSong < 0) currentSong = playlist.length - 1;

  loadSong(currentSong);
  audio.play();
};

// AUTO NEXT PAG TAPOS
audio.addEventListener("ended", function () {
  nextMusic();
});

window.openAbout = function () {
  document.getElementById("settingsCard").classList.add("hidden");
  document.getElementById("aboutadminCard").classList.remove("hidden");
}

