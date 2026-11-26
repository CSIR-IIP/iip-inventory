import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
export default defineConfig({
  plugins:[react(),tailwind()],
  server:{
    port:5173,
    proxy:{
      '/api':{
        target:'http://localhost:3001',
        configure(proxy){
          proxy.on('proxyReq',(proxyReq,req)=>{
            if(req.headers.host)proxyReq.setHeader('x-forwarded-host',req.headers.host);
          });
        }
      }
    }
  },
  build:{outDir:'dist'}
});
