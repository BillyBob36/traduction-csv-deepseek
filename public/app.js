/**
 * Logique frontend pour l'application de traduction CSV
 * Gère l'upload, la progression SSE et le téléchargement des résultats
 */

// État global de l'application
const state = {
  files: [],
  selectedLanguage: '',
  sessionId: null,
  eventSource: null,
  translatedFiles: [],
  isTranslating: false,
  testMode: false,
  testLines: 10
};

// Éléments DOM
const elements = {
  uploadZone: document.getElementById('uploadZone'),
  fileInput: document.getElementById('fileInput'),
  selectFilesBtn: document.getElementById('selectFilesBtn'),
  filesList: document.getElementById('filesList'),
  filesListItems: document.getElementById('filesListItems'),
  clearFilesBtn: document.getElementById('clearFilesBtn'),
  languageSection: document.getElementById('languageSection'),
  languageSelect: document.getElementById('languageSelect'),
  estimateSection: document.getElementById('estimateSection'),
  actionSection: document.getElementById('actionSection'),
  translateBtn: document.getElementById('translateBtn'),
  progressSection: document.getElementById('progressSection'),
  progressPercent: document.getElementById('progressPercent'),
  progressFill: document.getElementById('progressFill'),
  progressFiles: document.getElementById('progressFiles'),
  progressLines: document.getElementById('progressLines'),
  currentFileName: document.getElementById('currentFileName'),
  cacheHitRate: document.getElementById('cacheHitRate'),
  currentCost: document.getElementById('currentCost'),
  resultsSection: document.getElementById('resultsSection'),
  resultDuration: document.getElementById('resultDuration'),
  resultCacheHit: document.getElementById('resultCacheHit'),
  resultCost: document.getElementById('resultCost'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  individualDownloads: document.getElementById('individualDownloads'),
  newTranslationBtn: document.getElementById('newTranslationBtn'),
  errorSection: document.getElementById('errorSection'),
  errorMessage: document.getElementById('errorMessage'),
  retryBtn: document.getElementById('retryBtn'),
  // Estimation
  estFiles: document.getElementById('estFiles'),
  estLines: document.getElementById('estLines'),
  estCost: document.getElementById('estCost'),
  estTime: document.getElementById('estTime'),
  // Test mode
  testSection: document.getElementById('testSection'),
  testModeCheckbox: document.getElementById('testModeCheckbox'),
  testLinesInput: document.getElementById('testLinesInput'),
  testLinesCount: document.getElementById('testLinesCount'),
  testBtn: document.getElementById('testBtn')
};

/**
 * Initialisation de l'application
 */
async function init() {
  // Charger les langues disponibles
  await loadLanguages();
  
  // Configurer les événements
  setupEventListeners();
}

/**
 * Charge la liste des langues depuis l'API
 */
async function loadLanguages() {
  try {
    const response = await fetch('/api/translate/languages');
    const languages = await response.json();
    
    elements.languageSelect.innerHTML = '<option value="">-- Choisir une langue --</option>';
    
    for (const [code, data] of Object.entries(languages)) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${data.name} (${data.nativeName})`;
      elements.languageSelect.appendChild(option);
    }
  } catch (error) {
    console.error('Erreur chargement langues:', error);
  }
}

/**
 * Configure tous les écouteurs d'événements
 */
function setupEventListeners() {
  // Upload zone - drag & drop
  elements.uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.uploadZone.classList.add('dragover');
  });

  elements.uploadZone.addEventListener('dragleave', () => {
    elements.uploadZone.classList.remove('dragover');
  });

  elements.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.uploadZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  // Upload zone - click
  elements.uploadZone.addEventListener('click', () => {
    elements.fileInput.click();
  });

  elements.selectFilesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });

  // Clear files
  elements.clearFilesBtn.addEventListener('click', clearFiles);

  // Language select
  elements.languageSelect.addEventListener('change', (e) => {
    state.selectedLanguage = e.target.value;
    updateUI();
    if (state.files.length > 0 && state.selectedLanguage) {
      getEstimate();
    }
  });

  // Translate button
  elements.translateBtn.addEventListener('click', () => startTranslation(false));

  // Test mode checkbox
  elements.testModeCheckbox.addEventListener('change', (e) => {
    state.testMode = e.target.checked;
    elements.testLinesInput.hidden = !state.testMode;
    elements.testBtn.hidden = !state.testMode;
    elements.translateBtn.hidden = state.testMode;
  });

  // Test lines count
  elements.testLinesCount.addEventListener('change', (e) => {
    state.testLines = parseInt(e.target.value) || 10;
  });

  // Test button
  elements.testBtn.addEventListener('click', () => startTranslation(true));

  // Download buttons
  elements.downloadAllBtn.addEventListener('click', downloadAll);
  elements.newTranslationBtn.addEventListener('click', resetApp);
  elements.retryBtn.addEventListener('click', () => startTranslation(false));
}

/**
 * Gère l'ajout de fichiers
 */
function handleFiles(fileList) {
  const csvFiles = Array.from(fileList).filter(f => 
    f.type === 'text/csv' || f.name.endsWith('.csv')
  );

  if (csvFiles.length === 0) {
    showError('Veuillez sélectionner des fichiers CSV uniquement.');
    return;
  }

  state.files = [...state.files, ...csvFiles];
  updateFilesList();
  updateUI();

  if (state.selectedLanguage) {
    getEstimate();
  }
}

/**
 * Met à jour l'affichage de la liste des fichiers
 */
function updateFilesList() {
  elements.filesListItems.innerHTML = '';

  state.files.forEach((file, index) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="file-info">
        <i class="fas fa-file-csv"></i>
        <span>${file.name}</span>
      </div>
      <div>
        <span class="file-size">${formatFileSize(file.size)}</span>
        <button class="remove-file" data-index="${index}">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `;
    elements.filesListItems.appendChild(li);
  });

  // Événements de suppression
  elements.filesListItems.querySelectorAll('.remove-file').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.currentTarget.dataset.index);
      state.files.splice(index, 1);
      updateFilesList();
      updateUI();
      if (state.files.length > 0 && state.selectedLanguage) {
        getEstimate();
      }
    });
  });
}

/**
 * Efface tous les fichiers sélectionnés
 */
function clearFiles() {
  state.files = [];
  elements.fileInput.value = '';
  updateFilesList();
  updateUI();
}

/**
 * Met à jour l'interface selon l'état
 */
function updateUI() {
  const hasFiles = state.files.length > 0;
  const hasLanguage = !!state.selectedLanguage;

  elements.filesList.hidden = !hasFiles;
  elements.languageSection.hidden = !hasFiles;
  elements.estimateSection.hidden = !(hasFiles && hasLanguage);
  elements.testSection.hidden = !(hasFiles && hasLanguage);
  elements.actionSection.hidden = !(hasFiles && hasLanguage);
}

/**
 * Obtient l'estimation du coût et du temps
 */
async function getEstimate() {
  if (state.files.length === 0) return;

  const formData = new FormData();
  state.files.forEach(file => formData.append('files', file));

  try {
    const response = await fetch('/api/translate/estimate', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error('Erreur estimation');

    const data = await response.json();

    elements.estFiles.textContent = data.totalFiles;
    elements.estLines.textContent = data.totalLines.toLocaleString();
    elements.estCost.textContent = `$${data.estimatedCost.toFixed(2)}`;
    elements.estTime.textContent = `~${data.estimatedTimeMinutes} min`;

  } catch (error) {
    console.error('Erreur estimation:', error);
  }
}

/**
 * Démarre la traduction
 * @param {boolean} isTest - Si true, mode test avec nombre limité de lignes
 */
async function startTranslation(isTest = false) {
  if (state.isTranslating) return;

  state.isTranslating = true;
  state.sessionId = `session_${Date.now()}`;
  state.translatedFiles = [];

  // Masquer les autres sections
  elements.actionSection.hidden = true;
  elements.estimateSection.hidden = true;
  elements.testSection.hidden = true;
  elements.errorSection.hidden = true;
  elements.resultsSection.hidden = true;
  elements.progressSection.hidden = false;

  // Réinitialiser la progression
  updateProgress(0, 0, 0);

  // Connecter au SSE pour la progression
  connectSSE();

  // Préparer le formulaire
  const formData = new FormData();
  state.files.forEach(file => formData.append('files', file));
  formData.append('targetLanguage', state.selectedLanguage);
  formData.append('sessionId', state.sessionId);

  // Mode test : limiter le nombre de lignes
  if (isTest) {
    formData.append('testMode', 'true');
    formData.append('testLines', state.testLines.toString());
  }

  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Erreur traduction');
    }

    // Récupérer le fichier traduit
    const contentType = response.headers.get('Content-Type');
    const contentDisposition = response.headers.get('Content-Disposition');
    const filename = extractFilename(contentDisposition) || `traduction_${state.selectedLanguage}.csv`;

    const blob = await response.blob();

    // Stocker pour téléchargement
    state.translatedFiles = [{
      name: filename,
      blob: blob,
      isZip: contentType.includes('zip')
    }];

    // Afficher les résultats
    showResults();

  } catch (error) {
    showError(error.message);
  } finally {
    state.isTranslating = false;
    disconnectSSE();
  }
}

/**
 * Connecte au flux SSE pour la progression
 */
function connectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource(`/api/translate/progress/${state.sessionId}`);

  state.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleSSEMessage(data);
  };

  state.eventSource.onerror = () => {
    console.warn('SSE connexion perdue, reconnexion...');
  };
}

/**
 * Déconnecte le SSE
 */
function disconnectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

/**
 * Gère les messages SSE
 */
function handleSSEMessage(data) {
  switch (data.type) {
    case 'init':
      elements.progressLines.textContent = `0/${data.totalLines.toLocaleString()}`;
      elements.progressFiles.textContent = `0/${data.totalFiles}`;
      break;

    case 'file_start':
      elements.currentFileName.textContent = data.fileName;
      break;

    case 'progress':
      updateProgress(
        data.percentComplete,
        data.globalProcessedLines,
        data.globalTotalLines
      );
      
      if (data.cacheStats) {
        elements.cacheHitRate.textContent = `${data.cacheStats.hitRate}%`;
        elements.currentCost.textContent = `$${data.cacheStats.estimatedCost.toFixed(4)}`;
      }
      break;

    case 'file_complete':
      const completedFiles = parseInt(elements.progressFiles.textContent.split('/')[0]) + 1;
      const totalFiles = data.fileIndex !== undefined ? state.files.length : 1;
      elements.progressFiles.textContent = `${completedFiles}/${totalFiles}`;
      break;

    case 'complete':
      elements.resultDuration.textContent = `${data.duration}s`;
      elements.resultCacheHit.textContent = `${data.cacheStats.hitRate}%`;
      elements.resultCost.textContent = `$${data.cacheStats.estimatedCost.toFixed(4)}`;
      break;

    case 'error':
      showError(data.message);
      break;
  }
}

/**
 * Met à jour la barre de progression
 */
function updateProgress(percent, processed, total) {
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressFill.style.width = `${percent}%`;
  elements.progressLines.textContent = `${processed.toLocaleString()}/${total.toLocaleString()}`;
}

/**
 * Affiche la section résultats
 */
function showResults() {
  elements.progressSection.hidden = true;
  elements.resultsSection.hidden = false;

  // Afficher les téléchargements individuels si plusieurs fichiers
  elements.individualDownloads.innerHTML = '';
  
  if (state.translatedFiles.length > 0 && !state.translatedFiles[0].isZip) {
    state.translatedFiles.forEach((file, index) => {
      const div = document.createElement('div');
      div.className = 'download-item';
      div.innerHTML = `
        <span><i class="fas fa-file-csv"></i> ${file.name}</span>
        <button class="btn btn-secondary" data-index="${index}">
          <i class="fas fa-download"></i> Télécharger
        </button>
      `;
      elements.individualDownloads.appendChild(div);
    });

    elements.individualDownloads.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.currentTarget.dataset.index);
        downloadFile(state.translatedFiles[index]);
      });
    });
  }
}

/**
 * Télécharge tous les fichiers
 */
function downloadAll() {
  if (state.translatedFiles.length === 0) return;

  // Si c'est déjà un ZIP, télécharger directement
  if (state.translatedFiles[0].isZip) {
    downloadFile(state.translatedFiles[0]);
    return;
  }

  // Sinon, télécharger le premier fichier (cas d'un seul CSV)
  downloadFile(state.translatedFiles[0]);
}

/**
 * Télécharge un fichier
 */
function downloadFile(file) {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Affiche une erreur
 */
function showError(message) {
  elements.progressSection.hidden = true;
  elements.resultsSection.hidden = true;
  elements.errorSection.hidden = false;
  elements.errorMessage.textContent = message;
  state.isTranslating = false;
}

/**
 * Réinitialise l'application
 */
function resetApp() {
  state.files = [];
  state.selectedLanguage = '';
  state.translatedFiles = [];
  state.isTranslating = false;

  elements.fileInput.value = '';
  elements.languageSelect.value = '';
  elements.filesListItems.innerHTML = '';
  elements.individualDownloads.innerHTML = '';

  elements.resultsSection.hidden = true;
  elements.errorSection.hidden = true;
  elements.progressSection.hidden = true;
  elements.filesList.hidden = true;
  elements.languageSection.hidden = true;
  elements.estimateSection.hidden = true;
  elements.testSection.hidden = true;
  elements.actionSection.hidden = true;

  // Reset test mode
  state.testMode = false;
  elements.testModeCheckbox.checked = false;
  elements.testLinesInput.hidden = true;
  elements.testBtn.hidden = true;
  elements.translateBtn.hidden = false;
}

/**
 * Formate la taille d'un fichier
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Extrait le nom de fichier du header Content-Disposition
 */
function extractFilename(contentDisposition) {
  if (!contentDisposition) return null;
  const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  if (match && match[1]) {
    return match[1].replace(/['"]/g, '');
  }
  return null;
}

// Lancer l'application
document.addEventListener('DOMContentLoaded', init);
