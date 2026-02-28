// ===================================================
//  SHELFWISE - Firebase-Integrated Application Logic
// ===================================================

// ---- UTILS (must be first) ----
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function statusLabel(s) { return { want:'Want to Read', reading:'Reading', read:'Read', dnf:'DNF', borrowed:'Borrowed' }[s] || s; }
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function downloadFile(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function parseCSV(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += ch;
    }
    vals.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i]||'').trim().replace(/^"|"$/g,'')]));
  });
}


// ========== BARCODE SCANNER ==========
let scannerStream = null;
let scannedBookData = null;

function openScanner() {
  showToast('Barcode scanner coming soon — please enter ISBN manually', 'info');
}
function closeScanner() {}
function stopCamera() {
  if (scannerStream) {
    try { scannerStream.getTracks().forEach(t => t.stop()); } catch(e) {}
    scannerStream = null;
  }
}
function addScannedBook() {}
function handleISBNDetected() {}

async function handleISBNDetected(isbn) {
  clearInterval(scannerInterval);
  stopCamera();
  document.getElementById('scanner-status').textContent = '✅ Barcode detected!';
  document.getElementById('scanner-isbn-display').textContent = isbn;
  document.getElementById('scanner-result').style.display = 'block';
  document.getElementById('scanner-book-preview').textContent = 'Looking up book...';

  try {
    // Try Hardcover first for ISBN lookup
    let found = null;
    try {
      const hcQuery = `query { books(where: {default_physical_edition: {isbn_13: {_eq: "${isbn}"}}}, limit: 1) {
        id title contributions { author { name } }
        default_physical_edition { isbn_13 isbn_10 pages_count publisher { name } image { url } }
        cached_image { url } description
      }}`;
      const hcRes = await fetch('https://api.hardcover.app/v1/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: hcQuery })
      });
      const hcData = await hcRes.json();
      const b = hcData?.data?.books?.[0];
      if (b) {
        const ed = b.default_physical_edition;
        found = {
          id: String(b.id),
          title: b.title,
          author: (b.contributions||[]).map(c => c.author?.name).filter(Boolean).join(', ') || 'Unknown',
          genre: '',
          pages: ed?.pages_count || 0,
          description: b.description || '',
          isbn: ed?.isbn_13 || isbn,
          publisher: ed?.publisher?.name || '',
          coverUrl: b.cached_image?.url || ed?.image?.url || '',
        };
      }
    } catch(e) { console.warn('Hardcover ISBN lookup failed'); }

    // Fall back to Open Library
    if (!found) {
      const olRes = await fetch(`https://openlibrary.org/isbn/${isbn}.json`);
      if (olRes.ok) {
        const olData = await olRes.json();
        const coverId = olData.covers?.[0];
        found = {
          id: isbn,
          title: olData.title || 'Unknown Title',
          author: 'Unknown',
          genre: '',
          pages: olData.number_of_pages || 0,
          description: '',
          isbn,
          publisher: (olData.publishers||[])[0] || '',
          coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` :
                    `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
        };
      }
    }

    if (found) {
      scannedBookData = found;
      document.getElementById('scanner-book-preview').textContent =
        `"${scannedBookData.title}" by ${scannedBookData.author}`;
      document.getElementById('scanner-add-btn').style.display = 'flex';
    } else {
      document.getElementById('scanner-book-preview').textContent =
        'Book not found in database. You can still add it manually.';
      scannedBookData = { isbn, title: '', author: '', coverUrl: '' };
      document.getElementById('scanner-add-btn').style.display = 'flex';
    }
  } catch(e) {
    document.getElementById('scanner-book-preview').textContent = 'Lookup failed — check your connection.';
  }
}

function addScannedBook() {
  if (!scannedBookData) return;
  closeScanner();
  openAddModal(scannedBookData);
}

function stopCamera() {
  cancelAnimationFrame(scannerAnimFrame);
  if (zxingReader) { try { zxingReader.reset(); } catch(e){} zxingReader = null; }
  if (scannerStream) {
    if (scannerStream.getTracks) {
      scannerStream.getTracks().forEach(t => t.stop());
    }
    const video = document.getElementById('scanner-video');
    if (video) { video.srcObject = null; }
  }
  scannerStream = null;
}

function closeScanner() {
  stopCamera();
  closeModal('scanner-modal');
}

// ========== END BARCODE SCANNER ==========
// ---- INIT ----
document.addEventListener('DOMContentLoaded', () => {
  loadLocal();
  applyTheme();
  const year = new Date().getFullYear();
  document.getElementById('goal-year').textContent = year;
  document.getElementById('goal-year-setting').textContent = year;
  if (settings.goal) document.getElementById('goal-input').value = settings.goal;
  const themeToggle = document.getElementById('theme-toggle-settings');
  if (themeToggle) themeToggle.classList.toggle('on', settings.theme === 'dark');
  refreshDashboard();
});

// ---- STATE ----
let books = [];
let collections = [];
let settings = { theme: 'dark', goal: 0, goalYear: new Date().getFullYear() };
let currentRating = 0;
let currentStatusFilter = 'all';
let currentView = 'grid';
let currentSortBy = 'dateAdded';
// Filter panel state
const fp = { status:'all', ownership:[], genres:[], authors:[], tags:[], rating:-1 };
let selectedEmoji = '📚';
let editingBookId = null;
let lastSearchResults = [];
let coverRefreshAttempts = {};
let currentUser = null;
let unsubscribeBooks = null;
let unsubscribeCollections = null;
let syncTimeout = null;

// ---- FIREBASE HELPERS ----
function fb() { return window._fb; }
function uid() { return currentUser?.uid; }

function setSyncStatus(status) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.className = 'sync-dot' + (status === 'syncing' ? ' syncing' : status === 'error' ? ' error' : '');
  dot.title = status === 'syncing' ? 'Syncing...' : status === 'error' ? 'Sync error' : 'Synced to cloud';
}

// ---- FIRESTORE PATHS ----
function booksCol() { return fb().collection(fb().db, 'users', uid(), 'books'); }
function collectionsCol() { return fb().collection(fb().db, 'users', uid(), 'collections'); }
function settingsDoc() { return fb().doc(fb().db, 'users', uid(), 'config', 'settings'); }

// ---- SAVE TO FIRESTORE ----
async function saveBookToFirestore(book) {
  if (!uid()) return;
  setSyncStatus('syncing');
  try {
    await fb().setDoc(fb().doc(booksCol(), book.id), { ...book, updatedAt: fb().serverTimestamp() });
    setSyncStatus('synced');
  } catch(e) { setSyncStatus('error'); console.error(e); }
}

async function deleteBookFromFirestore(bookId) {
  if (!uid()) return;
  setSyncStatus('syncing');
  try {
    await fb().deleteDoc(fb().doc(booksCol(), bookId));
    setSyncStatus('synced');
  } catch(e) { setSyncStatus('error'); }
}

async function saveCollectionToFirestore(col) {
  if (!uid()) return;
  try {
    await fb().setDoc(fb().doc(collectionsCol(), col.id), col);
  } catch(e) { console.error(e); }
}

async function saveSettingsToFirestore() {
  if (!uid()) return;
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      await fb().setDoc(settingsDoc(), settings);
    } catch(e) { console.error(e); }
  }, 800);
}

// ---- SUBSCRIBE TO REALTIME UPDATES ----
function subscribeToData() {
  // Unsubscribe existing listeners
  if (unsubscribeBooks) unsubscribeBooks();
  if (unsubscribeCollections) unsubscribeCollections();

  // Books realtime
  unsubscribeBooks = fb().onSnapshot(booksCol(), snap => {
    books = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    books.sort((a,b) => (b.dateAdded||0) - (a.dateAdded||0));
    // Only re-render library if it's visible
    if (document.getElementById('page-library')?.classList.contains('active')) {
      renderLibrary();
    }
    refreshDashboard();
    updateLibCount();
  }, err => {
    console.error('Books sync error:', err);
    setSyncStatus('error');
  });

  // Collections realtime
  unsubscribeCollections = fb().onSnapshot(collectionsCol(), snap => {
    collections = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    renderCollections();
    refreshDashboard();
  });
}

async function loadSettings() {
  if (!uid()) return;
  try {
    const snap = await fb().getDoc(settingsDoc());
    if (snap.exists()) {
      settings = { ...settings, ...snap.data() };
      applyTheme();
      const gi = document.getElementById('goal-input');
      if (gi && settings.goal) gi.value = settings.goal;
    }
  } catch(e) { console.error(e); }
}

// ---- LOCAL STORAGE FALLBACK (offline support) ----
function saveLocal() {
  try {
    localStorage.setItem('sw_books', JSON.stringify(books));
    localStorage.setItem('sw_collections', JSON.stringify(collections));
    localStorage.setItem('sw_settings', JSON.stringify(settings));
  } catch(e) {}
}
function loadLocal() {
  try {
    const b = localStorage.getItem('sw_books');
    const c = localStorage.getItem('sw_collections');
    const s = localStorage.getItem('sw_settings');
    if (b) books = JSON.parse(b);
    if (c) collections = JSON.parse(c);
    if (s) settings = { ...settings, ...JSON.parse(s) };
  } catch(e) {}
}
// Keep local as cache
function save() {
  saveLocal();
  saveSettingsToFirestore();
}

// ---- AUTH FUNCTIONS ----
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => t.classList.toggle('active', (i===0) === (tab==='signin')));
  document.getElementById('auth-signin').classList.toggle('active', tab === 'signin');
  document.getElementById('auth-signup').classList.toggle('active', tab === 'signup');
}

async function authSignIn() {
  const email = document.getElementById('signin-email').value.trim();
  const password = document.getElementById('signin-password').value;
  const errEl = document.getElementById('signin-error');
  errEl.classList.remove('show');
  if (!email || !password) { showAuthError(errEl, 'Please fill in all fields'); return; }
  try {
    await fb().signInWithEmailAndPassword(fb().auth, email, password);
  } catch(e) {
    showAuthError(errEl, friendlyAuthError(e.code));
  }
}

async function authSignUp() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.classList.remove('show');
  if (!email || !password) { showAuthError(errEl, 'Please fill in all fields'); return; }
  try {
    const cred = await fb().createUserWithEmailAndPassword(fb().auth, email, password);
    // Store display name in settings
    if (name) {
      settings.displayName = name;
      await saveSettingsToFirestore();
    }
  } catch(e) {
    showAuthError(errEl, friendlyAuthError(e.code));
  }
}

async function authWithGoogle() {
  try {
    await fb().signInWithPopup(fb().auth, fb().googleProvider);
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      showToast('Google sign-in failed: ' + friendlyAuthError(e.code), 'error');
    }
  }
}

async function authForgotPassword() {
  const email = document.getElementById('signin-email').value.trim();
  if (!email) { showAuthError(document.getElementById('signin-error'), 'Enter your email address first'); return; }
  try {
    await fb().sendPasswordResetEmail(fb().auth, email);
    showToast('Password reset email sent!', 'success');
  } catch(e) {
    showAuthError(document.getElementById('signin-error'), friendlyAuthError(e.code));
  }
}

async function authSignOut() {
  if (!confirm('Sign out of ConnieReads?')) return;
  if (unsubscribeBooks) unsubscribeBooks();
  if (unsubscribeCollections) unsubscribeCollections();
  books = []; collections = [];
  await fb().signOut(fb().auth);
}

function showAuthError(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
}

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-email': 'Invalid email address.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/email-already-in-use': 'An account already exists with this email.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/invalid-credential': 'Invalid email or password.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

function updateUserUI(user) {
  const nameEl = document.getElementById('user-display-name');
  const avatarEl = document.getElementById('user-avatar');
  if (!user) return;
  const displayName = user.displayName || settings.displayName || user.email?.split('@')[0] || 'Reader';
  if (nameEl) nameEl.textContent = displayName;
  if (avatarEl) {
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${user.photoURL}" alt=""/>`;
    } else {
      avatarEl.textContent = displayName[0].toUpperCase();
    }
  }
  // Update greeting
  const greetEl = document.querySelector('.greeting h1');
  if (greetEl) greetEl.innerHTML = `Welcome back, <span>${displayName.split(' ')[0]}</span>`;
}

// ---- AUTH STATE HANDLER ----
window._onAuthReady = async (user) => {
  const authScreen = document.getElementById('auth-screen');
  const authLoading = document.getElementById('auth-loading');
  const authForms = document.getElementById('auth-forms');

  if (user) {
    currentUser = user;
    authScreen.classList.add('hidden');
    updateUserUI(user);
    setSyncStatus('syncing');
    await loadSettings();
    subscribeToData();
    refreshDashboard();
    setSyncStatus('synced');
  } else {
    currentUser = null;
    books = []; collections = [];
    authScreen.classList.remove('hidden');
    authLoading.classList.remove('show');
    authForms.style.display = 'block';
    renderLibrary();
    refreshDashboard();
  }
};

// ---- NAVIGATION ----
const pageTitles = { dashboard:'Dashboard', search:'Discover', library:'My Library', collections:'Collections', stats:'Statistics', settings:'Settings' };
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.mobile-nav-item').forEach(n => n.classList.remove('active'));

  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  document.querySelector(`[onclick="showPage('${page}')"]`)?.classList.add('active');
  const mob = document.getElementById('mob-' + page);
  if (mob) mob.classList.add('active');

  document.getElementById('page-title').textContent = pageTitles[page] || page;
  // search wrap removed
  document.getElementById('add-book-btn').style.display = (page === 'settings') ? 'none' : 'flex';
  closeSidebar();

  if (page === 'dashboard') refreshDashboard();
  if (page === 'library') renderLibrary();
  if (page === 'collections') renderCollections();
  if (page === 'stats') renderStats();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-backdrop').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('open');
}

// ---- THEME ----
// applyTheme merged above

const THEMES = ['dark','light','midnight','forest','rose','slate'];

function setTheme(name) {
  settings.theme = name;
  applyTheme();
  save();
}

function toggleTheme() {
  // Legacy toggle: cycle dark/light only (used by sidebar toggle)
  settings.theme = (settings.theme === 'dark' || !THEMES.includes(settings.theme)) ? 'light' : 'dark';
  applyTheme();
  save();
}

function applyTheme() {
  const theme = THEMES.includes(settings.theme) ? settings.theme : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  // Update swatch active states
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === theme);
  });
  // Update legacy sidebar toggle
  const isDark = (theme !== 'light');
  const themeBtn = document.querySelector('.theme-toggle');
  if (themeBtn) {
    const txt = themeBtn.childNodes[2];
    if (txt) txt.textContent = isDark ? ' Light Mode' : ' Dark Mode';
  }
}

// ---- MODALS ----
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ---- ADD/EDIT BOOK MODAL ----
function openAddModal(prefill = null) {
  editingBookId = null;
  currentRating = 0;
  document.getElementById('modal-title').textContent = 'Add Book';
  document.getElementById('delete-book-btn').style.display = 'none';
  clearBookForm();
  if (prefill) {
    document.getElementById('f-title').value = prefill.title || '';
    document.getElementById('f-author').value = prefill.author || '';
    document.getElementById('f-genre').value = prefill.genre || '';
    document.getElementById('f-isbn').value = prefill.isbn || '';
    document.getElementById('f-pages').value = prefill.pages || '';
    document.getElementById('cover-url-input').value = prefill.coverUrl || '';
    if (prefill.tags) setTagsInForm(prefill.tags);
    updateCoverPreview();
    updateModalTitle();
    if (prefill.description) {
      document.getElementById('modal-book-info-display').style.display = 'block';
      document.getElementById('modal-book-title-display').textContent = prefill.title || '';
      document.getElementById('modal-book-author-display').textContent = prefill.author || '';
      document.getElementById('modal-book-desc-display').textContent = prefill.description || '';
    }
  }
  renderCollectionCheckboxes([]);
  openModal('book-modal');
}

function openEditModal(bookId) {
  const book = books.find(b => b.id === bookId);
  if (!book) return;
  editingBookId = bookId;
  currentRating = book.rating || 0;
  document.getElementById('modal-title').textContent = 'Edit Book';
  document.getElementById('delete-book-btn').style.display = 'flex';
  document.getElementById('edit-book-id').value = bookId;
  document.getElementById('f-title').value = book.title || '';
  document.getElementById('f-author').value = book.author || '';
  document.getElementById('f-genre').value = book.genre || '';
  document.getElementById('f-isbn').value = book.isbn || '';
  document.getElementById('f-status').value = book.status || 'want';
  document.getElementById('f-date-read').value = book.dateRead || '';
  document.getElementById('f-date-started').value = book.dateStarted || '';
  setTagsInForm(book.tags || []);
  document.getElementById('f-pages').value = book.pages || '';
  document.getElementById('f-pages-read').value = book.pagesRead || '';
  document.getElementById('f-copies').value = book.copies || '';
  document.getElementById('f-borrowed-from').value = book.borrowedFrom || '';
  document.getElementById('f-notes').value = book.notes || '';
  document.getElementById('cover-url-input').value = book.coverUrl || '';
  updateCoverPreview();
  updateModalTitle();
  updateStars(currentRating);

  const physLbl = document.getElementById('own-physical-lbl');
  const digLbl = document.getElementById('own-digital-lbl');
  const borLbl = document.getElementById('own-borrowed-lbl');
  document.getElementById('own-physical').checked = book.ownPhysical || false;
  document.getElementById('own-digital').checked = book.ownDigital || false;
  document.getElementById('own-borrowed').checked = book.ownBorrowed || false;
  physLbl.classList.toggle('checked', book.ownPhysical || false);
  digLbl.classList.toggle('checked', book.ownDigital || false);
  borLbl.classList.toggle('checked', book.ownBorrowed || false);

  if (book.description) {
    document.getElementById('modal-book-info-display').style.display = 'block';
    document.getElementById('modal-book-title-display').textContent = book.title || '';
    document.getElementById('modal-book-author-display').textContent = book.author || '';
    document.getElementById('modal-book-desc-display').textContent = book.description || '';
  }

  renderCollectionCheckboxes(book.collections || []);
  openModal('book-modal');
}


// ========== TAG INPUT SYSTEM ==========
function getTagsFromInput() {
  const hidden = document.getElementById('f-tags');
  if (!hidden) return [];
  return hidden.value ? hidden.value.split('|||').filter(Boolean) : [];
}

function setTagsInForm(tags) {
  const chips = document.getElementById('tag-chips');
  const hidden = document.getElementById('f-tags');
  if (!chips || !hidden) return;
  hidden.value = tags.join('|||');
  chips.innerHTML = tags.map(t => tagChipHTML(t)).join('');
}

function tagChipHTML(tag) {
  return `<span class="tag-chip">${escHtml(tag)}<span class="tag-chip-remove" onclick="removeTag(${JSON.stringify(tag)})">×</span></span>`;
}

function handleTagInput(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().replace(/,$/, '');
    if (val) addTag(val);
    e.target.value = '';
  } else if (e.key === 'Backspace' && e.target.value === '') {
    const tags = getTagsFromInput();
    if (tags.length) removeTag(tags[tags.length - 1]);
  }
}

function addTag(tag) {
  const tags = getTagsFromInput();
  if (!tags.includes(tag)) {
    tags.push(tag);
    setTagsInForm(tags);
  }
}

function removeTag(tag) {
  const tags = getTagsFromInput().filter(t => t !== tag);
  setTagsInForm(tags);
}
// ========== END TAG INPUT ==========

function clearBookForm() {
  ['f-title','f-author','f-genre','f-isbn','f-date-read','f-date-started','f-notes','f-copies','f-borrowed-from','cover-url-input','f-pages','f-pages-read'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('f-status').value = 'want';
  document.getElementById('f-tags').value = '';
  document.getElementById('f-tags-input').value = '';
  document.getElementById('tag-chips').innerHTML = '';
  document.getElementById('own-physical').checked = false;
  document.getElementById('own-digital').checked = false;
  document.getElementById('own-borrowed').checked = false;
  document.getElementById('own-physical-lbl').classList.remove('checked');
  document.getElementById('own-digital-lbl').classList.remove('checked');
  document.getElementById('own-borrowed-lbl').classList.remove('checked');
  document.getElementById('modal-cover-preview').innerHTML = '📚';
  document.getElementById('modal-book-info-display').style.display = 'none';
  currentRating = 0;
  updateStars(0);
}

function updateModalTitle() {
  const title = document.getElementById('f-title').value;
  const author = document.getElementById('f-author').value;
  if (title || author) {
    document.getElementById('modal-book-info-display').style.display = 'block';
    document.getElementById('modal-book-title-display').textContent = title;
    document.getElementById('modal-book-author-display').textContent = author;
  }
  // Refresh spine preview live as user types title
  const url = document.getElementById('cover-url-input').value.trim();
  if (!url && (title || author)) updateCoverPreview();
}

function updateCoverPreview() {
  const url = document.getElementById('cover-url-input').value.trim();
  const title = document.getElementById('f-title').value.trim();
  const author = document.getElementById('f-author').value.trim();
  const preview = document.getElementById('modal-cover-preview');
  if (url) {
    const fakeBook = { title, author, coverUrl: url };
    preview.innerHTML = bookCoverImg(fakeBook, 'spine-lg');
  } else if (title) {
    preview.innerHTML = bookSpineHTML({ title, author }, 'spine-lg');
  } else {
    preview.innerHTML = '📚';
  }
}

function toggleCheckbox(labelId, inputId) {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  if (input && label) label.classList.toggle('checked', input.checked);
}

function setRating(val) {
  currentRating = currentRating === val ? 0 : val;
  updateStars(currentRating);
}

function updateStars(val) {
  document.querySelectorAll('.star-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.val) <= val);
  });
}

function renderCollectionCheckboxes(selected = []) {
  const cont = document.getElementById('collection-checkboxes');
  if (collections.length === 0) {
    cont.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">No collections yet. Create one in Collections.</span>';
    return;
  }
  cont.innerHTML = collections.map(col => `
    <label class="checkbox-item ${selected.includes(col.id) ? 'checked' : ''}" id="col-check-${col.id}" style="margin:2px;">
      <input type="checkbox" value="${col.id}" ${selected.includes(col.id) ? 'checked' : ''} 
        onchange="this.closest('label').classList.toggle('checked', this.checked)"/>
      ${col.emoji} ${col.name}
    </label>
  `).join('');
}

async function saveBook() {
  const title = document.getElementById('f-title').value.trim();
  const author = document.getElementById('f-author').value.trim();
  if (!title) { showToast('Please enter a book title', 'error'); return; }
  if (!uid()) { showToast('Please sign in to save books', 'error'); return; }

  const selectedCols = Array.from(document.querySelectorAll('#collection-checkboxes input:checked')).map(i => i.value);
  const coverUrl = document.getElementById('cover-url-input').value.trim();

  const bookData = {
    title,
    author: author || 'Unknown',
    genre: document.getElementById('f-genre').value.trim(),
    isbn: document.getElementById('f-isbn').value.trim(),
    status: document.getElementById('f-status').value,
    dateRead: document.getElementById('f-date-read').value,
    dateStarted: document.getElementById('f-date-started').value,
    tags: getTagsFromInput(),
    pages: parseInt(document.getElementById('f-pages').value) || 0,
    pagesRead: parseInt(document.getElementById('f-pages-read').value) || 0,
    rating: currentRating,
    ownPhysical: document.getElementById('own-physical').checked,
    ownDigital: document.getElementById('own-digital').checked,
    ownBorrowed: document.getElementById('own-borrowed').checked,
    copies: parseInt(document.getElementById('f-copies').value) || (document.getElementById('own-physical').checked ? 1 : 0),
    borrowedFrom: document.getElementById('f-borrowed-from').value.trim(),
    notes: document.getElementById('f-notes').value.trim(),
    coverUrl,
    collections: selectedCols,
    description: document.getElementById('modal-book-desc-display').textContent || '',
  };

  closeModal('book-modal');

  if (editingBookId) {
    const existing = books.find(b => b.id === editingBookId);
    const updated = { ...existing, ...bookData, updatedAt: Date.now() };
    await saveBookToFirestore(updated);
    showToast(`"${title}" updated`, 'success');
    addActivity(`Updated <strong>${title}</strong>`, '✏️', '#6a9bbf');
  } else {
    const book = { id: genId(), ...bookData, dateAdded: Date.now() };
    await saveBookToFirestore(book);
    showToast(`"${title}" added to library`, 'success');
    addActivity(`Added <strong>${title}</strong> by ${author || 'Unknown'}`, '📚', '#d4884a');
  }
}

async function deleteCurrentBook() {
  if (!editingBookId) return;
  const book = books.find(b => b.id === editingBookId);
  if (!book) return;
  if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
  addActivity(`Removed <strong>${book.title}</strong>`, '🗑️', '#c0605a');
  closeModal('book-modal');
  await deleteBookFromFirestore(editingBookId);
  showToast(`"${book.title}" deleted`, 'info');
}

// ---- COVER REFRESH (Hardcover + Open Library, no Google Books) ----
async function refreshCover() {
  const title = document.getElementById('f-title').value.trim();
  const author = document.getElementById('f-author').value.trim();
  const isbn = document.getElementById('f-isbn').value.trim();
  if (!title && !isbn) { showToast('Enter a title or ISBN first', 'error'); return; }

  const key = isbn || `${title}_${author}`;
  coverRefreshAttempts[key] = (coverRefreshAttempts[key] || 0) + 1;
  showToast('Searching for cover...', 'info');

  const sources = [];

  // 1. Open Library by ISBN (most reliable if we have one)
  if (isbn) {
    sources.push(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`);
    sources.push(`https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`);
  }

  // 2. Try Hardcover API for cover
  try {
    const q = isbn ? `_eq: "${isbn}"` : `_ilike: "%${title.replace(/"/g,'')}%"`;
    const field = isbn ? 'isbn_13' : 'title';
    const hcQuery = isbn
      ? `{ books(where: {default_physical_edition: {isbn_13: {_eq: "${isbn}"}}}, limit: 3) { cached_image { url } default_physical_edition { image { url } } } }`
      : `{ books(where: {title: {_ilike: "%${title.replace(/"/g,'')}%"}}, order_by: {users_count: desc}, limit: 5) { cached_image { url } default_physical_edition { image { url } } } }`;
    const hcRes = await fetch('https://api.hardcover.app/v1/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query ${hcQuery}` })
    });
    if (hcRes.ok) {
      const hcData = await hcRes.json();
      (hcData.data?.books || []).forEach(b => {
        if (b.cached_image?.url) sources.push(b.cached_image.url);
        if (b.default_physical_edition?.image?.url) sources.push(b.default_physical_edition.image.url);
      });
    }
  } catch(e) { /* Hardcover unavailable */ }

  // 3. Open Library by title
  sources.push(`https://covers.openlibrary.org/b/title/${encodeURIComponent(title)}-L.jpg`);

  // 4. Open Library search by title+author
  try {
    const olQ = encodeURIComponent(`${title}${author ? ' ' + author : ''}`);
    const olRes = await fetch(`https://openlibrary.org/search.json?q=${olQ}&limit=3&fields=cover_i,isbn`);
    if (olRes.ok) {
      const olData = await olRes.json();
      (olData.docs || []).forEach(doc => {
        if (doc.cover_i) sources.push(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`);
        const docIsbn = (doc.isbn || [])[0];
        if (docIsbn) sources.push(`https://covers.openlibrary.org/b/isbn/${docIsbn}-L.jpg`);
      });
    }
  } catch(e) { /* OL search unavailable */ }

  const uniq = [...new Set(sources)];
  if (!uniq.length) {
    showToast('No covers found — try pasting a URL manually.', 'error');
    return;
  }

  const idx = coverRefreshAttempts[key] % uniq.length;
  document.getElementById('cover-url-input').value = uniq[idx];
  updateCoverPreview();
  showToast(`Cover ${idx + 1} of ${uniq.length} — check preview ↑`, 'success');
}

// ---- BOOK SEARCH (Google Books + Open Library fallback) ----
// getBestCoverUrl - kept for any legacy calls but search now uses Hardcover/OL directly
function getBestCoverUrl(item) {
  // Legacy helper - now only called for any remaining Google Books results
  const info = item.volumeInfo || {};
  const imgLinks = info.imageLinks || {};
  const isbns = info.industryIdentifiers || [];
  const isbn13 = isbns.find(i => i.type === 'ISBN_13')?.identifier;
  const isbn10 = isbns.find(i => i.type === 'ISBN_10')?.identifier;
  if (isbn13) return `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg`;
  if (isbn10) return `https://covers.openlibrary.org/b/isbn/${isbn10}-L.jpg`;
  if (imgLinks.thumbnail) return imgLinks.thumbnail.replace('http:', 'https:').replace('&edge=curl', '');
  return '';
}

// ---- HARDCOVER API SEARCH ----
// Hardcover is a free book community API - no key needed for public search
async function searchHardcover(q) {
  const query = `query SearchBooks($q: String!) {
    books(where: {title: {_ilike: $q}}, order_by: {users_count: desc}, limit: 20) {
      id title
      contributions { author { name } }
      default_physical_edition { 
        isbn_13 isbn_10 pages_count
        image { url }
        publisher { name }
      }
      cached_image { url }
      description
    }
  }`;
  const res = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { q: `%${q}%` } })
  });
  if (!res.ok) throw new Error('Hardcover API error ' + res.status);
  const data = await res.json();
  return (data.data?.books || []).map(b => {
    const ed = b.default_physical_edition;
    const author = (b.contributions||[]).map(c => c.author?.name).filter(Boolean).join(', ') || 'Unknown';
    const coverUrl = b.cached_image?.url || ed?.image?.url || '';
    return {
      id: String(b.id),
      title: b.title || 'Unknown Title',
      author,
      genre: '',
      pages: ed?.pages_count || 0,
      description: b.description || '',
      isbn: ed?.isbn_13 || ed?.isbn_10 || String(b.id),
      publisher: ed?.publisher?.name || '',
      coverUrl,
      source: 'hardcover',
    };
  });
}

// Open Library search fallback
async function searchOpenLibrary(q) {
  const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=20&fields=key,title,author_name,isbn,number_of_pages_median,subject,publisher,cover_i`);
  if (!res.ok) throw new Error('Open Library error ' + res.status);
  const data = await res.json();
  return (data.docs || []).map(doc => {
    const isbn = (doc.isbn || [])[0] || '';
    const coverId = doc.cover_i;
    const coverUrl = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : 
                     isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : '';
    return {
      id: doc.key || isbn,
      title: doc.title || 'Unknown Title',
      author: (doc.author_name || []).join(', ') || 'Unknown',
      genre: (doc.subject || []).slice(0, 2).join(', '),
      pages: doc.number_of_pages_median || 0,
      description: '',
      isbn,
      publisher: (doc.publisher || [])[0] || '',
      coverUrl,
      source: 'openlibrary',
    };
  });
}

async function searchBooks(query) {
  const input = document.getElementById('discover-search');
  const q = (query || input.value).trim();
  if (!q) return;
  input.value = q;
  showPage('search');

  const grid = document.getElementById('search-results-grid');
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-muted);">
    <div style="font-size:32px;margin-bottom:12px;">🔍</div>
    <div>Searching Hardcover...</div>
  </div>`;

  let results = [];
  let source = '';

  // Try Hardcover first
  try {
    results = await searchHardcover(q);
    source = 'hardcover';
  } catch(e) {
    console.warn('Hardcover failed:', e.message, '— trying Open Library');
  }

  // Fall back to Open Library if Hardcover fails or returns nothing
  if (!results.length) {
    try {
      results = await searchOpenLibrary(q);
      source = 'openlibrary';
    } catch(e) {
      console.warn('Open Library failed:', e.message);
    }
  }

  if (!results.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-muted);">
      <div style="font-size:32px;margin-bottom:12px;">📭</div>
      <div style="font-size:15px;margin-bottom:8px;">No results for "<strong>${escHtml(q)}</strong>"</div>
      <div style="font-size:13px;">Try a different title, author, or ISBN</div>
    </div>`;
    return;
  }

  lastSearchResults = results;
  renderSearchResults(results);
  
  const sourceLabel = source === 'hardcover' ? '📗 Hardcover' : '📚 Open Library';
  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'grid-column:1/-1;font-size:11px;color:var(--text-muted);text-align:right;padding:4px 0;';
  statusEl.textContent = `${results.length} results via ${sourceLabel}`;
  grid.appendChild(statusEl);
}

function renderSearchResults(results) {
  const grid = document.getElementById('search-results-grid');
  if (!results.length) {
    grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);">No results found. Try a different search.</div>';
    return;
  }
  grid.innerHTML = results.map((book, i) => {
    const inLib = books.some(b => b.isbn === book.isbn || b.title.toLowerCase() === book.title.toLowerCase());
    const coverHtml = book.coverUrl 
      ? `<img src="${book.coverUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" alt="${escHtml(book.title)}"/><div style="display:none;width:100%;height:100%;">${bookSpineHTML(book)}</div>`
      : bookSpineHTML(book);
    return `
      <div class="search-result-card" style="animation-delay:${i * 0.04}s">
        <div class="search-cover">${coverHtml}</div>
        <div class="search-book-title">${escHtml(book.title)}</div>
        <div class="search-book-author">${escHtml(book.author)}</div>
        <button class="search-add-btn ${inLib ? 'added' : ''}" onclick="addFromSearch(${i})">
          ${inLib ? '✓ In Library' : '+ Add to Library'}
        </button>
      </div>
    `;
  }).join('');
}

function addFromSearch(index) {
  const book = lastSearchResults[index];
  openAddModal(book);
}

// ---- BOOK SPINE PLACEHOLDER GENERATOR ----
const SPINE_COLORS = [
  ['#7c3f1e','#a0552a'],['#1e3a5f','#2a5080'],['#2d5a1b','#3d7a26'],
  ['#5a1e3f','#7a2a55'],['#3f3f1e','#5a5a2a'],['#1e4a4a','#2a6a6a'],
  ['#5a2d1e','#7a3f2a'],['#1e1e5a','#2a2a7a'],['#4a1e5a','#6a2a7a'],
  ['#5a1e1e','#7a2a2a'],['#1e5a3a','#2a7a50'],['#3a1e5a','#502a7a'],
];

function getSpineColor(title) {
  let hash = 0;
  for (let i = 0; i < (title||'').length; i++) hash = ((hash << 5) - hash) + title.charCodeAt(i);
  return SPINE_COLORS[Math.abs(hash) % SPINE_COLORS.length];
}

function bookSpineHTML(book, sizeClass = '') {
  const [bg1, bg2] = getSpineColor(book.title || '');
  return `<div class="book-spine ${sizeClass}" style="background:linear-gradient(135deg, ${bg1}, ${bg2});">
    <div class="book-spine-title">${escHtml(book.title || '')}</div>
    <div class="book-spine-author">${escHtml(book.author || '')}</div>
  </div>`;
}

function bookCoverImg(book, fallbackSizeClass = '') {
  if (book.coverUrl) {
    return `<img src="${escHtml(book.coverUrl)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" alt="${escHtml(book.title)}"/><div style="display:none;width:100%;height:100%;">${bookSpineHTML(book, fallbackSizeClass)}</div>`;
  }
  return bookSpineHTML(book, fallbackSizeClass);
}

// ---- RENDER BOOK CARD ----
let _renderLibTimer = null;
function renderLibrary() {
  // Debounce rapid calls (e.g. realtime Firestore updates)
  clearTimeout(_renderLibTimer);
  _renderLibTimer = setTimeout(_doRenderLibrary, 50);
}
function _doRenderLibrary() {
  buildFilterOptions();
  updateOwnedCounts();

  const searchQ = (document.getElementById('lib-search')?.value || '').toLowerCase().trim();

  let filtered = books.filter(b => {
    // Text search
    if (searchQ && ![b.title, b.author, b.genre, ...(b.tags||[])].some(s => (s||'').toLowerCase().includes(searchQ))) return false;
    // Status
    if (fp.status !== 'all' && b.status !== fp.status) return false;
    // Ownership
    if (fp.ownership.includes('physical') && !b.ownPhysical) return false;
    if (fp.ownership.includes('digital') && !b.ownDigital) return false;
    if (fp.ownership.includes('borrowed') && !b.ownBorrowed) return false;
    // Genre
    if (fp.genres.length && !fp.genres.includes(b.genre)) return false;
    // Author
    if (fp.authors.length && !fp.authors.includes(b.author)) return false;
    // Tags
    if (fp.tags.length && !fp.tags.some(t => (b.tags||[]).includes(t))) return false;
    // Rating
    if (fp.rating === 0 && b.rating > 0) return false;
    if (fp.rating > 0 && (b.rating || 0) < fp.rating) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (currentSortBy === 'title') return a.title.localeCompare(b.title);
    if (currentSortBy === 'author') return a.author.localeCompare(b.author);
    if (currentSortBy === 'rating') return (b.rating || 0) - (a.rating || 0);
    if (currentSortBy === 'dateRead') return (b.dateRead || '').localeCompare(a.dateRead || '');
    return (b.dateAdded || 0) - (a.dateAdded || 0);
  });

  // Update active filter summary
  updateFilterBadge();

  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');

  if (filtered.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    empty.style.display = 'block';
    empty.querySelector('h3').textContent = books.length ? 'No books match your filters' : 'Your library is empty';
    empty.querySelector('p').textContent = books.length ? 'Try clearing some filters.' : 'Search for books in Discover or use the + Add Book button.';
    return;
  }
  grid.style.display = '';
  empty.style.display = 'none';

  if (currentView === 'grid') {
    grid.className = 'books-grid';
    grid.innerHTML = filtered.map((book, i) => renderBookCard(book, i)).join('');
  } else {
    grid.className = 'books-list';
    grid.innerHTML = filtered.map((book, i) => renderBookListItem(book, i)).join('');
  }
}

function buildFilterOptions() {
  // Genres
  const genres = [...new Set(books.map(b => b.genre).filter(Boolean))].sort();
  const fpGenres = document.getElementById('fp-genres');
  if (fpGenres) {
    fpGenres.innerHTML = genres.map(g => `
      <button class="filter-chip-sm ${fp.genres.includes(g)?'active':''}" 
        onclick="fpToggleGenre(${JSON.stringify(g)},this)">${escHtml(g)}</button>
    `).join('') || '<span style="font-size:12px;color:var(--text-muted);">No genres yet</span>';
  }
  // Authors (top 10 by count)
  const authorMap = {};
  books.forEach(b => { if(b.author) authorMap[b.author] = (authorMap[b.author]||0)+1; });
  const topAuthors = Object.entries(authorMap).sort((a,b)=>b[1]-a[1]).slice(0,12).map(e=>e[0]);
  const fpAuthors = document.getElementById('fp-authors');
  if (fpAuthors) {
    fpAuthors.innerHTML = topAuthors.map(a => `
      <button class="filter-chip-sm ${fp.authors.includes(a)?'active':''}" 
        onclick="fpToggleAuthor(${JSON.stringify(a)},this)">${escHtml(a)}</button>
    `).join('') || '<span style="font-size:12px;color:var(--text-muted);">No authors yet</span>';
  }
  // Tags
  const tagSet = new Set();
  books.forEach(b => (b.tags||[]).forEach(t => tagSet.add(t)));
  const allTags = [...tagSet].sort();
  const fpTags = document.getElementById('fp-tags');
  if (fpTags) {
    fpTags.innerHTML = allTags.map(t => `
      <button class="filter-chip-sm ${fp.tags.includes(t)?'active':''}" 
        onclick="fpToggleTag(${JSON.stringify(t)},this)">${escHtml(t)}</button>
    `).join('') || '<span style="font-size:12px;color:var(--text-muted);">No tags yet</span>';
  }
}

function updateOwnedCounts() {
  const allC = document.getElementById('ob-all-count');
  const physC = document.getElementById('ob-physical-count');
  const digC = document.getElementById('ob-digital-count');
  const borC = document.getElementById('ob-borrowed-count');
  if (allC) allC.textContent = books.length;
  if (physC) physC.textContent = books.filter(b=>b.ownPhysical).length;
  if (digC) digC.textContent = books.filter(b=>b.ownDigital).length;
  if (borC) borC.textContent = books.filter(b=>b.ownBorrowed).length;
}

function updateFilterBadge() {
  let count = 0;
  if (fp.status !== 'all') count++;
  count += fp.ownership.length;
  count += fp.genres.length;
  count += fp.authors.length;
  count += fp.tags.length;
  if (fp.rating >= 0) count++;
  const searchQ = (document.getElementById('lib-search')?.value || '').trim();
  if (searchQ) count++;

  const badge = document.getElementById('filter-badge');
  const btn = document.getElementById('filter-toggle-btn');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count ? 'inline-flex' : 'none';
  }
  if (btn) btn.classList.toggle('active', count > 0);

  const summary = document.getElementById('active-filter-summary');
  if (summary) {
    if (count === 0) { summary.textContent = 'None'; return; }
    const parts = [];
    if (fp.status !== 'all') parts.push('Status: ' + fp.status);
    if (fp.ownership.length) parts.push('Format: ' + fp.ownership.join(', '));
    if (fp.genres.length) parts.push('Genre: ' + fp.genres.join(', '));
    if (fp.authors.length) parts.push('Author: ' + fp.authors.slice(0,2).join(', ') + (fp.authors.length>2?'…':''));
    if (fp.tags.length) parts.push('Tags: ' + fp.tags.join(', '));
    if (fp.rating === 0) parts.push('Unrated');
    else if (fp.rating > 0) parts.push(fp.rating+'★+');
    summary.textContent = parts.join(' · ');
  }
}

// Filter panel actions
function toggleFilterPanel() {
  const panel = document.getElementById('filter-panel');
  panel.classList.toggle('open');
}

function fpSetStatus(status, el) {
  fp.status = status;
  document.querySelectorAll('#fp-status .filter-chip-sm').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderLibrary();
}

function fpToggleOwn(own, el) {
  const idx = fp.ownership.indexOf(own);
  if (idx >= 0) fp.ownership.splice(idx, 1);
  else fp.ownership.push(own);
  el.classList.toggle('active', fp.ownership.includes(own));
  renderLibrary();
}

function setOwnershipFilter(own) {
  // Quick filter from owned count bar
  if (own === 'all') { fp.ownership = []; }
  else {
    const has = fp.ownership.includes(own);
    fp.ownership = has ? [] : [own];
  }
  // Update filter panel chips if open
  document.querySelectorAll('#fp-ownership .filter-chip-sm').forEach(b => {
    b.classList.toggle('active', fp.ownership.includes(b.dataset.own));
  });
  // Update owned bar active states
  document.querySelectorAll('.owned-badge').forEach(b => b.classList.remove('active'));
  const target = document.getElementById('ob-' + own);
  if (target) target.classList.add('active');
  if (own === 'all') document.getElementById('ob-all')?.classList.add('active');
  renderLibrary();
}

function fpToggleGenre(genre, el) {
  const idx = fp.genres.indexOf(genre);
  if (idx >= 0) fp.genres.splice(idx, 1);
  else fp.genres.push(genre);
  el.classList.toggle('active', fp.genres.includes(genre));
  renderLibrary();
}

function fpToggleAuthor(author, el) {
  const idx = fp.authors.indexOf(author);
  if (idx >= 0) fp.authors.splice(idx, 1);
  else fp.authors.push(author);
  el.classList.toggle('active', fp.authors.includes(author));
  renderLibrary();
}

function fpToggleTag(tag, el) {
  const idx = fp.tags.indexOf(tag);
  if (idx >= 0) fp.tags.splice(idx, 1);
  else fp.tags.push(tag);
  el.classList.toggle('active', fp.tags.includes(tag));
  renderLibrary();
}

function fpSetRating(rating, el) {
  fp.rating = fp.rating === rating ? -1 : rating;
  document.querySelectorAll('#fp-rating .filter-chip-sm').forEach(b => b.classList.remove('active'));
  if (fp.rating >= 0) el.classList.add('active');
  renderLibrary();
}

function clearAllFilters() {
  fp.status = 'all'; fp.ownership = []; fp.genres = []; fp.authors = []; fp.tags = []; fp.rating = -1;
  const si = document.getElementById('lib-search');
  if (si) si.value = '';
  document.querySelectorAll('#filter-panel .filter-chip-sm').forEach(b => b.classList.remove('active'));
  document.querySelector('#fp-status [data-status="all"]')?.classList.add('active');
  document.querySelectorAll('.owned-badge').forEach(b => b.classList.remove('active'));
  document.getElementById('ob-all')?.classList.add('active');
  renderLibrary();
}

function renderBookCard(book, i) {
  const stars = book.rating ? '★'.repeat(book.rating) : '';
  const ownerBadge = book.ownBorrowed ? '<div class="cover-badge borrowed">B</div>'
    : (book.ownPhysical || book.ownDigital) ? '<div class="cover-badge owned">✓</div>' : '';
  const tagsHtml = (book.tags||[]).length
    ? '<div class="tag-display" style="margin-top:4px;">' + book.tags.slice(0,2).map(t=>'<span class="tag-badge">'+escHtml(t)+'</span>').join('') + '</div>'
    : '';
  const delay = (i * 0.03).toFixed(2);
  return `<div class="book-card" onclick="openBookDetail('${book.id}')" style="animation-delay:${delay}s">
    <div class="book-cover-lg">${bookCoverImg(book)}${ownerBadge}</div>
    <div class="book-card-title">${escHtml(book.title)}</div>
    <div class="book-card-author">${escHtml(book.author)}</div>
    <div class="book-card-meta"><span class="status-badge status-${book.status}">${statusLabel(book.status)}</span>${stars ? `<span class="stars-small">${stars}</span>` : ''}</div>
    ${tagsHtml}
  </div>`;
}

function renderBookListItem(book, i) {
  const stars = book.rating ? '★'.repeat(book.rating) : '';
  const ownTags = [
    book.ownPhysical && '<span class="status-badge" style="background:var(--green-soft);color:var(--green);">📖 Physical</span>',
    book.ownDigital && '<span class="status-badge" style="background:var(--blue-soft);color:var(--blue);">💻 Digital</span>',
    book.ownBorrowed && '<span class="status-badge" style="background:var(--purple-soft);color:var(--purple);">🤝 Borrowed</span>',
  ].filter(Boolean).join('');
  return `
    <div class="book-list-item" onclick="openBookDetail('${book.id}')">
      <div class="book-list-cover">${bookCoverImg(book)}</div>
      <div class="book-list-info">
        <div class="book-list-title">${escHtml(book.title)}</div>
        <div class="book-list-author">${escHtml(book.author)}${book.genre ? ` · ${escHtml(book.genre)}` : ''}</div>
        <div class="book-list-badges">
          <span class="status-badge status-${book.status}">${statusLabel(book.status)}</span>
          ${ownTags}
          ${(book.tags||[]).slice(0,3).map(t=>`<span class="tag-badge">${escHtml(t)}</span>`).join('')}
        </div>
      </div>
      <div class="book-list-meta">
        ${stars ? `<span style="color:var(--star);font-size:13px;">${stars}</span>` : ''}
        ${book.pages ? `<span style="font-size:11px;color:var(--text-muted);">${book.pages}p</span>` : ''}
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:12px;" onclick="event.stopPropagation();openEditModal('${book.id}')">Edit</button>
      </div>
    </div>
  `;
}

function filterLibrary() { renderLibrary(); } // filter via status chips + sort
// setStatusFilter replaced by fpSetStatus
function setSortBy(val) { currentSortBy = val; renderLibrary(); }
function setView(view) {
  currentView = view;
  document.getElementById('grid-view-btn').classList.toggle('active', view === 'grid');
  document.getElementById('list-view-btn').classList.toggle('active', view === 'list');
  renderLibrary();
}

// ---- BOOK DETAIL ----
function openBookDetail(bookId) {
  const book = books.find(b => b.id === bookId);
  if (!book) return;
  const coverHtml = bookCoverImg(book, 'spine-lg');
  const stars = book.rating ? '★'.repeat(book.rating) + '☆'.repeat(5-book.rating) : '☆☆☆☆☆';
  const progress = book.pages && book.pagesRead ? Math.round((book.pagesRead / book.pages) * 100) : 0;
  const ownDetails = [
    book.ownPhysical && `📖 Physical Copy (${book.copies || 1})`,
    book.ownDigital && '💻 Digital Copy',
    book.ownBorrowed && `🤝 Borrowed${book.borrowedFrom ? ' from ' + book.borrowedFrom : ''}`,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const colNames = (book.collections || []).map(cid => {
    const col = collections.find(c => c.id === cid);
    return col ? `${col.emoji} ${col.name}` : null;
  }).filter(Boolean).join(', ');

  const dateLine = [
    book.dateStarted && `📅 Started: ${book.dateStarted}`,
    book.dateRead && `✅ Finished: ${book.dateRead}`,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  document.getElementById('book-detail-body').innerHTML = `
    <div style="display:flex; gap:22px; margin-bottom:24px;">
      <div style="width:100px;height:150px;border-radius:6px;overflow:hidden;flex-shrink:0;background:var(--bg-elevated);box-shadow:4px 4px 16px rgba(0,0,0,0.35);">${coverHtml}</div>
      <div>
        <div style="font-family:'Playfair Display',serif;font-size:22px;font-weight:700;color:var(--text-primary);margin-bottom:4px;">${escHtml(book.title)}</div>
        <div style="font-family:'Lora',serif;font-size:14px;font-style:italic;color:var(--text-secondary);margin-bottom:10px;">${escHtml(book.author)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="status-badge status-${book.status}">${statusLabel(book.status)}</span>
          ${book.genre ? `<span class="status-badge" style="background:var(--bg-elevated);color:var(--text-secondary);">${escHtml(book.genre)}</span>` : ''}
        </div>
        <div style="color:var(--star);font-size:18px;margin-bottom:8px;">${stars}</div>
        ${book.pages ? `<div style="font-size:12px;color:var(--text-muted);">${book.pages} pages${book.pagesRead ? ` · ${book.pagesRead} read` : ''}</div>` : ''}
        ${progress ? `<div style="margin-top:8px;"><div style="height:4px;background:var(--bg-elevated);border-radius:2px;overflow:hidden;width:150px;"><div style="height:100%;background:var(--accent);width:${progress}%;border-radius:2px;"></div></div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">${progress}% read</div></div>` : ''}
      </div>
    </div>
    ${ownDetails ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">${ownDetails}</div>` : ''}
    ${colNames ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Collections: ${colNames}</div>` : ''}
    ${dateLine ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${dateLine}</div>` : ''}
    ${(book.tags||[]).length ? `<div style="margin-bottom:12px;"><span style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Tags</span><div class="tag-display" style="margin-top:5px;">${book.tags.map(t=>`<span class="tag-badge">${escHtml(t)}</span>`).join('')}</div></div>` : ''}
    ${book.description ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:16px;padding:14px;background:var(--bg-elevated);border-radius:9px;">${escHtml(book.description.substring(0,400))}${book.description.length > 400 ? '...' : ''}</div>` : ''}
    ${book.notes ? `<div style="margin-top:16px;"><div style="font-size:12px;font-weight:500;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Notes & Review</div><div style="font-size:13px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;padding:14px;background:var(--bg-elevated);border-radius:9px;">${escHtml(book.notes)}</div></div>` : ''}
  `;
  document.getElementById('detail-edit-btn').onclick = () => { closeModal('book-detail-modal'); openEditModal(bookId); };
  openModal('book-detail-modal');
}

// ---- COLLECTIONS ----
function openNewCollectionModal() {
  document.getElementById('col-name').value = '';
  selectedEmoji = '📚';
  document.querySelectorAll('.emoji-opt').forEach(e => { e.style.background = ''; e.style.borderColor = ''; });
  openModal('collection-modal');
}

function selectEmoji(el, emoji) {
  document.querySelectorAll('.emoji-opt').forEach(e => { e.style.background = ''; e.style.borderColor = ''; });
  el.style.background = 'var(--accent-soft)';
  el.style.borderColor = 'var(--accent)';
  selectedEmoji = emoji;
  document.getElementById('col-emoji').value = emoji;
}

async function saveCollection() {
  const name = document.getElementById('col-name').value.trim();
  if (!name) { showToast('Enter a collection name', 'error'); return; }
  const col = { id: genId(), name, emoji: selectedEmoji, createdAt: Date.now() };
  closeModal('collection-modal');
  await saveCollectionToFirestore(col);
  showToast(`Collection "${name}" created`, 'success');
}

function renderCollections() {
  const grid = document.getElementById('collections-grid');
  grid.innerHTML = collections.map(col => {
    const colBooks = books.filter(b => (b.collections || []).includes(col.id));
    const coverPreviews = colBooks.slice(0, 4).map(b => `
      <div class="collection-cover-mini">${b.coverUrl ? `<img src="${b.coverUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='block';" alt=""/><div style="display:none;width:100%;height:100%;">${bookSpineHTML(b)}</div>` : bookSpineHTML(b)}</div>
    `).join('');
    const more = colBooks.length > 4 ? `<div class="collection-more">+${colBooks.length - 4}</div>` : '';
    return `
      <div class="collection-card">
        <div>
          <span class="collection-emoji">${col.emoji}</span>
          <div class="collection-name">${escHtml(col.name)}</div>
          <div class="collection-count">${colBooks.length} book${colBooks.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="collection-covers">${coverPreviews}${more}</div>
      </div>
    `;
  }).join('') + `
    <div class="collection-card add-collection-card" onclick="openNewCollectionModal()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Create New Collection
    </div>
  `;
}

// ---- DASHBOARD ----
const activityLog = [];
function addActivity(text, icon, color) {
  activityLog.unshift({ text, icon, color, time: Date.now() });
  if (activityLog.length > 20) activityLog.pop();
}

function refreshDashboard() {
  const year = new Date().getFullYear();
  const readBooks = books.filter(b => b.status === 'read');
  const readThisYear = readBooks.filter(b => b.dateRead && b.dateRead.startsWith(year.toString()));
  const reading = books.filter(b => b.status === 'reading');
  const want = books.filter(b => b.status === 'want');

  document.getElementById('stat-total').textContent = books.length;
  document.getElementById('stat-read').textContent = readBooks.length;
  document.getElementById('stat-read-year').textContent = `${readThisYear.length} this year`;
  document.getElementById('stat-reading').textContent = reading.length;

  const goal = settings.goal || 0;
  document.getElementById('goal-year').textContent = year;
  document.getElementById('goal-year-setting').textContent = year;
  if (goal > 0) {
    const pct = Math.min(100, Math.round((readThisYear.length / goal) * 100));
    document.getElementById('stat-goal-pct').textContent = pct + '%';
    document.getElementById('stat-goal-detail').textContent = `${readThisYear.length}/${goal} books`;
    document.getElementById('goal-title-text').textContent = `Reading Goal ${year}`;
    document.getElementById('goal-count-text').innerHTML = `${readThisYear.length} <span>/ ${goal}</span>`;
    document.getElementById('goal-progress-fill').style.width = pct + '%';
    const remaining = goal - readThisYear.length;
    const daysLeft = Math.ceil((new Date(year, 11, 31) - new Date()) / 86400000);
    document.getElementById('goal-meta-text').textContent = remaining > 0 
      ? `${remaining} books to go · ${daysLeft} days left this year` 
      : `🎉 Goal achieved! You've read ${readThisYear.length} books this year.`;
  } else {
    document.getElementById('stat-goal-pct').textContent = '—';
    document.getElementById('stat-goal-detail').textContent = 'no goal set';
  }

  // Currently reading
  const crList = document.getElementById('currently-reading-list');
  if (reading.length) {
    crList.innerHTML = reading.map(book => {
      const progress = book.pages && book.pagesRead ? Math.round((book.pagesRead / book.pages) * 100) : 0;
      const cover = `<div class="book-cover-sm">${bookCoverImg(book)}</div>`;
      return `
        <div class="book-item-horizontal" onclick="openBookDetail('${book.id}')" style="cursor:pointer;">
          ${cover}
          <div class="book-info-sm">
            <div class="book-title-sm">${escHtml(book.title)}</div>
            <div class="book-author-sm">${escHtml(book.author)}</div>
            <div class="reading-progress">
              <div class="reading-progress-bar"><div class="reading-progress-fill" style="width:${progress}%"></div></div>
              <span class="reading-pct">${progress ? progress+'%' : 'In Progress'}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } else {
    crList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">No books in progress. Start reading!</div>';
  }

  // Want to read
  const wantList = document.getElementById('want-to-read-list');
  document.getElementById('want-count').textContent = `${want.length} book${want.length !== 1 ? 's' : ''}`;
  if (want.length) {
    wantList.innerHTML = want.slice(0, 5).map(book => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;" onclick="openBookDetail('${book.id}')">
        <div style="width:28px;height:42px;border-radius:3px;overflow:hidden;flex-shrink:0;">
          ${bookCoverImg(book)}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(book.title)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${escHtml(book.author)}</div>
        </div>
      </div>
    `).join('');
  } else {
    wantList.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Your wish list is empty</div>';
  }

  // Activity
  const actList = document.getElementById('activity-list');
  if (activityLog.length) {
    actList.innerHTML = activityLog.slice(0, 8).map(a => `
      <div class="activity-item">
        <div class="activity-dot" style="background:${a.color}"></div>
        <div class="activity-text">${a.text}</div>
        <div class="activity-time">${timeAgo(a.time)}</div>
      </div>
    `).join('');
  } else {
    actList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">No activity yet. Add some books!</div>';
  }

  // Collections in dashboard
  const dashCols = document.getElementById('dash-collections');
  if (collections.length) {
    dashCols.innerHTML = collections.map(col => {
      const count = books.filter(b => (b.collections || []).includes(col.id)).length;
      return `<div class="collection-pill" onclick="showPage('collections')">${col.emoji} ${escHtml(col.name)} <span class="pill-count">${count}</span></div>`;
    }).join('');
  } else {
    dashCols.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">No collections yet</div>';
  }

  updateLibCount();
}

function updateLibCount() {
  document.getElementById('lib-count').textContent = books.length;
}

// ---- STATS ----
function renderStats() {
  const readBooks = books.filter(b => b.status === 'read');
  const allBooks = books;
  document.getElementById('s-total').textContent = allBooks.length;
  document.getElementById('s-read').textContent = readBooks.length;
  const rated = readBooks.filter(b => b.rating && b.rating > 0);
  document.getElementById('s-avg-rating').textContent = rated.length 
    ? (rated.reduce((s,b) => s + b.rating, 0) / rated.length).toFixed(1) + '★'
    : '—';
  const genres = new Set(readBooks.map(b => b.genre).filter(Boolean));
  document.getElementById('s-genres').textContent = genres.size;

  // ---- Year chart ----
  const yearCounts = {};
  const curYear = new Date().getFullYear();
  for (let y = curYear - 4; y <= curYear; y++) yearCounts[y] = 0;
  readBooks.forEach(b => {
    if (b.dateRead) {
      const y = parseInt(b.dateRead.substring(0, 4));
      if (yearCounts[y] !== undefined) yearCounts[y]++;
    }
  });
  const maxYear = Math.max(...Object.values(yearCounts), 1);
  document.getElementById('year-chart').innerHTML = Object.entries(yearCounts).map(([y, c]) => `
    <div class="year-bar-wrap">
      <div class="year-bar" data-val="${c}" style="height:${Math.max(4, (c/maxYear)*100)}%; background:${y == curYear ? 'var(--accent)' : 'var(--border)'}; margin-top:auto;" title="${c} books in ${y}"></div>
      <div class="year-bar-label">${y}</div>
    </div>
  `).join('');

  // ---- Monthly chart (current year) ----
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthlyCounts = new Array(12).fill(0);
  readBooks.forEach(b => {
    if (b.dateRead && b.dateRead.startsWith(curYear.toString())) {
      const m = parseInt(b.dateRead.substring(5, 7)) - 1;
      if (m >= 0 && m < 12) monthlyCounts[m]++;
    }
  });
  const maxMonth = Math.max(...monthlyCounts, 1);
  document.getElementById('monthly-chart').innerHTML = monthlyCounts.map((c, i) => `
    <div class="year-bar-wrap">
      <div class="year-bar" data-val="${c}" style="height:${Math.max(4, (c/maxMonth)*100)}%; background:${i === new Date().getMonth() ? 'var(--accent)' : 'var(--blue)'}; opacity:${c===0?'0.3':'1'}; margin-top:auto;" title="${c} books in ${monthNames[i]}"></div>
      <div class="year-bar-label">${monthNames[i].substring(0,1)}</div>
    </div>
  `).join('');

  // ---- Genre chart ----
  const genreCount = {};
  readBooks.forEach(b => { if (b.genre) genreCount[b.genre] = (genreCount[b.genre]||0) + 1; });
  const topGenres = Object.entries(genreCount).sort((a,b) => b[1]-a[1]).slice(0,6);
  const maxGenre = topGenres[0]?.[1] || 1;
  const genreColors = ['var(--accent)','var(--green)','var(--blue)','var(--purple)','var(--red)','var(--star)'];
  document.getElementById('genre-chart').innerHTML = topGenres.length 
    ? topGenres.map(([g, c], i) => `
        <div class="bar-row">
          <div class="bar-label">${escHtml(g.substring(0,12))}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(c/maxGenre)*100}%;background:${genreColors[i%genreColors.length]};"></div></div>
          <div class="bar-value">${c}</div>
        </div>
      `).join('')
    : '<div style="color:var(--text-muted);font-size:13px;">Add genres to see stats</div>';

  // ---- Top Authors (most read) ----
  const authorCount = {};
  readBooks.forEach(b => { if (b.author) authorCount[b.author] = (authorCount[b.author]||0) + 1; });
  const topAuthors = Object.entries(authorCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  const rankLabels = ['gold','silver','bronze','',''];
  document.getElementById('authors-list').innerHTML = topAuthors.length 
    ? topAuthors.map(([a, c], i) => `
        <div class="top-item">
          <div class="top-rank ${rankLabels[i]}">${i+1}</div>
          <div class="top-info"><div class="top-name">${escHtml(a)}</div><div class="top-sub">Author</div></div>
          <div class="top-val">${c} book${c!==1?'s':''}</div>
        </div>
      `).join('')
    : '<div style="color:var(--text-muted);font-size:13px;">No books marked as read yet</div>';

  // ---- Rating distribution ----
  const ratingDist = [0,0,0,0,0];
  rated.forEach(b => { if (b.rating >= 1 && b.rating <= 5) ratingDist[b.rating-1]++; });
  const maxRating = Math.max(...ratingDist, 1);
  document.getElementById('rating-chart').innerHTML = [5,4,3,2,1].map(r => `
    <div class="bar-row">
      <div class="bar-label">${'★'.repeat(r)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(ratingDist[r-1]/maxRating)*100}%;background:var(--star);"></div></div>
      <div class="bar-value">${ratingDist[r-1]}</div>
    </div>
  `).join('');

  // ---- Best Rated Books Leaderboard ----
  const ratedBooks = readBooks.filter(b => b.rating > 0).sort((a,b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    return (b.dateRead || '').localeCompare(a.dateRead || '');
  }).slice(0, 10);
  const medalClass = (i) => i === 0 ? 'lb-medal-1' : i === 1 ? 'lb-medal-2' : i === 2 ? 'lb-medal-3' : 'lb-medal-n';
  const medalChar = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}`;
  document.getElementById('best-rated-list').innerHTML = ratedBooks.length
    ? ratedBooks.map((book, i) => `
        <div class="leaderboard-item" onclick="openBookDetail('${book.id}')" style="cursor:pointer;">
          <div class="leaderboard-rank ${medalClass(i)}">${medalChar(i)}</div>
          <div class="leaderboard-cover">${bookCoverImg(book)}</div>
          <div class="leaderboard-info">
            <div class="leaderboard-title">${escHtml(book.title)}</div>
            <div class="leaderboard-sub">${escHtml(book.author)}${book.dateRead ? ' · ' + book.dateRead.substring(0,4) : ''}</div>
          </div>
          <div class="leaderboard-score">${'★'.repeat(book.rating)}</div>
        </div>
      `).join('')
    : '<div style="color:var(--text-muted);font-size:13px;padding:10px 0;">Rate some books to see your leaderboard</div>';

  // ---- Most Read Authors (with cover sample) ----
  const authorData = {};
  readBooks.forEach(b => {
    if (!b.author) return;
    if (!authorData[b.author]) authorData[b.author] = { count: 0, books: [], totalRating: 0, ratedCount: 0 };
    authorData[b.author].count++;
    authorData[b.author].books.push(b);
    if (b.rating) { authorData[b.author].totalRating += b.rating; authorData[b.author].ratedCount++; }
  });
  const topAuthorsFull = Object.entries(authorData).sort((a,b) => b[1].count - a[1].count).slice(0, 8);
  document.getElementById('most-read-authors-list').innerHTML = topAuthorsFull.length
    ? topAuthorsFull.map(([author, data], i) => {
        const avgRating = data.ratedCount ? (data.totalRating / data.ratedCount).toFixed(1) : null;
        const sampleBook = data.books.find(b => b.coverUrl) || data.books[0];
        return `
          <div class="leaderboard-item">
            <div class="leaderboard-rank ${medalClass(i)}">${medalChar(i)}</div>
            <div class="leaderboard-cover">${sampleBook ? bookCoverImg(sampleBook) : ''}</div>
            <div class="leaderboard-info">
              <div class="leaderboard-title">${escHtml(author)}</div>
              <div class="leaderboard-sub">${data.count} book${data.count!==1?'s':''}${avgRating ? ` · avg ${avgRating}★` : ''}</div>
            </div>
            <div class="leaderboard-score" style="color:var(--accent);">${data.count}</div>
          </div>
        `;
      }).join('')
    : '<div style="color:var(--text-muted);font-size:13px;padding:10px 0;">No read books yet</div>';

  // ---- Reading Summary ----
  const totalPages = readBooks.reduce((s, b) => s + (b.pages || 0), 0);
  const thisYearBooks = readBooks.filter(b => b.dateRead && b.dateRead.startsWith(curYear.toString()));
  const booksWithDates = readBooks.filter(b => b.dateStarted && b.dateRead);
  let avgDays = 0;
  if (booksWithDates.length) {
    const totalDays = booksWithDates.reduce((s, b) => {
      const diff = (new Date(b.dateRead) - new Date(b.dateStarted)) / 86400000;
      return s + (diff > 0 ? diff : 0);
    }, 0);
    avgDays = Math.round(totalDays / booksWithDates.length);
  }
  document.getElementById('reading-summary').innerHTML = `
    <div class="time-stat-box">
      <div class="time-stat-val">${thisYearBooks.length}</div>
      <div class="time-stat-label">Books this year</div>
    </div>
    <div class="time-stat-box">
      <div class="time-stat-val">${totalPages > 1000 ? (totalPages/1000).toFixed(1)+'k' : totalPages}</div>
      <div class="time-stat-label">Pages read total</div>
    </div>
    <div class="time-stat-box">
      <div class="time-stat-val">${avgDays || '—'}</div>
      <div class="time-stat-label">Avg days per book</div>
    </div>
  `;

  // ---- Format Breakdown ----
  const owned = books.filter(b => b.ownPhysical || b.ownDigital || b.ownBorrowed);
  const physCount = books.filter(b => b.ownPhysical).length;
  const digCount = books.filter(b => b.ownDigital).length;
  const borCount = books.filter(b => b.ownBorrowed).length;
  const maxFmt = Math.max(physCount, digCount, borCount, 1);
  document.getElementById('format-chart').innerHTML = [
    ['📖 Physical', physCount, 'var(--green)'],
    ['💻 Digital', digCount, 'var(--blue)'],
    ['🤝 Borrowed', borCount, 'var(--purple)'],
  ].map(([label, count, color]) => `
    <div class="bar-row">
      <div class="bar-label" style="font-size:11px;">${label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(count/maxFmt)*100}%;background:${color};"></div></div>
      <div class="bar-value">${count}</div>
    </div>
  `).join('') + (physCount + digCount + borCount === 0 ? '<div style="color:var(--text-muted);font-size:13px;">Track ownership when adding books</div>' : '');
}

// ---- SETTINGS ----
function showSettingsPanel(id, el) {
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('sp-' + id).classList.add('active');
  el.classList.add('active');
  if (id === 'appearance') {
    // Highlight active theme swatch
    document.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.theme === settings.theme);
    });
  }
  if (id === 'profile') {
    const nameEl = document.getElementById('profile-display-name');
    const emailEl = document.getElementById('profile-email');
    if (nameEl) nameEl.value = settings.displayName || currentUser?.displayName || '';
    if (emailEl) emailEl.textContent = currentUser?.email || '—';
  }
}

async function saveDisplayName() {
  const name = document.getElementById('profile-display-name').value.trim();
  if (!name) { showToast('Please enter a display name', 'error'); return; }
  settings.displayName = name;
  save();
  // Update greeting and sidebar
  updateUserUI(currentUser);
  showToast(`Display name updated to "${name}"`, 'success');
}

async function saveGoal() {
  const val = parseInt(document.getElementById('goal-input').value);
  if (!val || val < 1) { showToast('Enter a valid goal (1+)', 'error'); return; }
  settings.goal = val;
  settings.goalYear = new Date().getFullYear();
  save();
  showToast(`Goal set: ${val} books in ${settings.goalYear}`, 'success');
  refreshDashboard();
}

// ---- IMPORT / EXPORT ----
function importGoodreads(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const text = e.target.result;
      const rows = parseCSV(text);
      if (!rows.length) { showToast('No books found in CSV', 'error'); return; }
      let added = 0;
      const batch = [];
      rows.forEach(row => {
        const title = row['Title'] || row['title'];
        const author = row['Author'] || row['author'] || row['Author l-f'];
        if (!title) return;
        const statusMap = { 'read': 'read', 'currently-reading': 'reading', 'to-read': 'want' };
        const grShelf = (row['Exclusive Shelf'] || 'to-read').toLowerCase();
        const status = statusMap[grShelf] || 'want';
        const rating = parseInt(row['My Rating'] || row['rating']) || 0;
        // Goodreads shelves → tags (not genre)
        const rawShelves = row['Bookshelves'] || row['Bookshelves with positions'] || '';
        const grTags = rawShelves.split(',').map(s => s.trim())
          .filter(s => s && !['read','currently-reading','to-read'].includes(s.toLowerCase()));
        if (!books.find(b => b.title.toLowerCase() === title.toLowerCase())) {
          const book = {
            id: genId(),
            title: title.trim(),
            author: (author || 'Unknown').replace(/,\s*(\w+)\s*$/, ' $1').trim(),
            genre: '',
            tags: grTags,
            status, rating,
            dateRead: row['Date Read'] || '',
            pages: parseInt(row['Number of Pages'] || row['pages']) || 0,
            notes: row['My Review'] || '',
            dateAdded: Date.now(),
            collections: [],
          };
          batch.push(book);
          added++;
        }
      });
      // Save each book to Firestore
      showToast(`Importing ${added} books...`, 'info');
      for (const book of batch) {
        await saveBookToFirestore(book);
      }
      showToast(`Imported ${added} books from Goodreads ✓`, 'success');
    } catch(err) {
      console.error(err);
      showToast('Failed to parse Goodreads CSV', 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function importShelfwise(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.books) {
        showToast(`Importing ${data.books.length} books...`, 'info');
        for (const book of data.books) {
          await saveBookToFirestore(book);
        }
      }
      if (data.collections) {
        for (const col of data.collections) {
          await saveCollectionToFirestore(col);
        }
      }
      if (data.settings) {
        settings = { ...settings, ...data.settings };
        await saveSettingsToFirestore();
        applyTheme();
      }
      showToast('Library restored from backup ✓', 'success');
    } catch(err) {
      showToast('Invalid ConnieReads JSON file', 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function exportData(format) {
  if (format === 'json') {
    const data = { books, collections, settings, exportedAt: new Date().toISOString(), version: '1.0' };
    downloadFile(JSON.stringify(data, null, 2), 'conniereads-backup.json', 'application/json');
    showToast('Library exported as JSON', 'success');
  } else if (format === 'csv') {
    const headers = ['Title','Author','Genre','Status','Rating','Date Read','Pages','Notes','Own Physical','Own Digital','Borrowed'];
    const rows = books.map(b => [
      b.title, b.author, b.genre || '', b.status, b.rating || '', b.dateRead || '', b.pages || '',
      (b.notes || '').replace(/"/g,'""'), b.ownPhysical ? 'Yes' : '', b.ownDigital ? 'Yes' : '', b.ownBorrowed ? 'Yes' : ''
    ].map(v => `"${v}"`).join(','));
    downloadFile([headers.join(','), ...rows].join('\n'), 'conniereads-library.csv', 'text/csv');
    showToast('Library exported as CSV', 'success');
  }
}

async function clearAllData() {
  if (!confirm('This will permanently delete ALL your books, collections, and settings from the cloud. This CANNOT be undone. Type DELETE to confirm.')) return;
  const conf = prompt('Type DELETE to confirm:');
  if (conf !== 'DELETE') return;
  showToast('Clearing all data...', 'info');
  // Delete all books
  for (const book of [...books]) {
    await deleteBookFromFirestore(book.id);
  }
  // Delete all collections
  for (const col of [...collections]) {
    try { await fb().deleteDoc(fb().doc(collectionsCol(), col.id)); } catch(e) {}
  }
  settings = { theme: settings.theme, goal: 0, goalYear: new Date().getFullYear() };
  await saveSettingsToFirestore();
  renderLibrary();
  renderCollections();
  refreshDashboard();
  showToast('All data cleared', 'info');
}

// ---- TOAST ----
function showToast(message, type = 'info') {
  const cont = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
  cont.appendChild(toast);
  setTimeout(() => { toast.classList.add('toast-fade-out'); setTimeout(() => toast.remove(), 300); }, 3500);
}

// ---- HELPERS ----
function genId() { return Math.random().toString(36).substr(2,9) + Date.now().toString(36); }