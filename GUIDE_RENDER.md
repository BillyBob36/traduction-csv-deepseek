# Guide de déploiement sur Render

## Étape 1 : Créer un compte Render

1. Aller sur [render.com](https://render.com)
2. Cliquer sur **Get Started for Free**
3. Se connecter avec GitHub (recommandé)

---

## Étape 2 : Créer le service web

1. Dans le dashboard Render, cliquer sur **New +** → **Web Service**

2. Connecter le repo GitHub :
   - Sélectionner **traduction-csv-deepseek**
   - Cliquer **Connect**

3. Configurer le service :

   | Champ | Valeur |
   |-------|--------|
   | **Name** | `csv-translator` (ou autre) |
   | **Region** | `Frankfurt (EU Central)` |
   | **Branch** | `master` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Plan** | `Starter ($7/month)` |

4. Cliquer **Create Web Service**

---

## Étape 3 : Ajouter la clé API DeepSeek

1. Une fois le service créé, aller dans l'onglet **Environment**

2. Cliquer **Add Environment Variable**

3. Ajouter :
   | Key | Value |
   |-----|-------|
   | `DEEPSEEK_API_KEY` | `sk-3d90eb6cb0ce41eb982fe700ce2d34d1` |

4. Cliquer **Save Changes**

5. Le service va redémarrer automatiquement

---

## Étape 4 : Vérifier le déploiement

1. Attendre que le statut passe à **Live** (2-3 minutes)

2. Cliquer sur l'URL fournie par Render :
   ```
   https://csv-translator-xxxx.onrender.com
   ```

3. Tester avec un petit fichier CSV

---

## Configuration optionnelle

### Health Check
Dans **Settings** → **Health & Alerts** :
- **Health Check Path** : `/health`

### Auto-Deploy
Par défaut activé : chaque push sur `master` déclenche un redéploiement.

---

## Dépannage

### Le service ne démarre pas
- Vérifier les logs dans l'onglet **Logs**
- S'assurer que `DEEPSEEK_API_KEY` est bien configurée

### Timeout sur gros fichiers
- Le plan Starter a un timeout de 30 secondes par défaut
- L'application utilise des batches courts pour éviter ce problème

### Erreur mémoire
- Le plan Starter a 512 MB de RAM
- Pour des fichiers > 50 MB, envisager le plan Standard ($25/mois)

---

## Coûts estimés

| Élément | Coût |
|---------|------|
| Render Starter | $7/mois |
| DeepSeek (100K lignes) | ~$2-3 |
| **Total mensuel typique** | **~$10-15** |
