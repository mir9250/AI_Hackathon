import { createClient } from '@supabase/supabase-js';
import { mountApp } from './app.js';
import './style.css';

mountApp(document.querySelector('#app'), import.meta.env, createClient);
