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