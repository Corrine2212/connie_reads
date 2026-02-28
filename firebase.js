import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
  import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
  import { getFirestore, doc, setDoc, getDoc, collection, getDocs, deleteDoc, writeBatch, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

  const firebaseConfig = {
    apiKey: "AIzaSyCYgcNE4Np86fBKt5GENBenXhyrsSQYVKQ",
    authDomain: "connie-reads.firebaseapp.com",
    projectId: "connie-reads",
    storageBucket: "connie-reads.firebasestorage.app",
    messagingSenderId: "648707030707",
    appId: "1:648707030707:web:4902dbe402be5a84933ac6",
    measurementId: "G-RJM75LPMG1"
  };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const googleProvider = new GoogleAuthProvider();

  // Expose to global scope for use in non-module scripts
  window._fb = { auth, db, googleProvider, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, signOut, onAuthStateChanged, sendPasswordResetEmail, doc, setDoc, getDoc, collection, getDocs, deleteDoc, writeBatch, onSnapshot, serverTimestamp };

  // Auth state listener - retry if main script not yet ready
  onAuthStateChanged(auth, user => {
    window._fbUser = user;
    if (window._onAuthReady) {
      window._onAuthReady(user);
    } else {
      // Main script not ready yet - poll until it is
      let retries = 0;
      const retry = setInterval(() => {
        retries++;
        if (window._onAuthReady) {
          clearInterval(retry);
          window._onAuthReady(user);
        } else if (retries > 50) {
          clearInterval(retry);
          console.error('ConnieReads: _onAuthReady never set - JS error in main script?');
        }
      }, 100);
    }
  });