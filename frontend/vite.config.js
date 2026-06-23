import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: path.resolve('./node_modules/react'),
      'react-dom': path.resolve('./node_modules/react-dom'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      // Regex stricte: ne matche que les chemins commençant par /api/
      // (ex: /api/settings, /api/risk/matrix), PAS les routes frontend
      // qui commencent par les mêmes lettres comme /api_keys.
      // L'ancienne clé '/api' faisait un match par préfixe et interceptait
      // /api_keys par erreur, le routant vers le backend Express qui
      // renvoyait alors une 404 JSON au lieu de laisser React Router gérer la route.
      '^/api/.*': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
    // Note: 'historyApiFallback' a été retiré — ce n'est pas une option
    // reconnue par le serveur dev de Vite (elle vient de webpack-dev-server).
    // Vite gère déjà nativement le SPA fallback (sert index.html pour toute
    // route qui ne correspond pas à un fichier réel), donc aucun équivalent
    // n'est nécessaire ici.
  },
  preview: {
    port: 3000,
  },
});