import { createClient } from '@supabase/supabase-js';
import { mountApp } from './app.js';
import './style.css';
import { mountPreview } from './preview.js';

if (import.meta.env.VITE_UI_PREVIEW === 'true') {
  mountPreview(document.querySelector('#app'));
} else {
  mountApp(document.querySelector('#app'), import.meta.env, createClient);
}
