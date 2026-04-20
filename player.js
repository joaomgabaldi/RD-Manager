import { localizeHtmlPage } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
  localizeHtmlPage();

  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  const title = params.get('title');

  if (title) {
    document.title = title;
    document.getElementById('title').textContent = title;
  }

  if (url) {
    document.getElementById('player').src = url;
    document.getElementById('btn-dl').href = url;
    
    const vlcBtn = document.getElementById('btn-vlc');
    vlcBtn.href = '#';
    vlcBtn.addEventListener('click', (e) => {
      e.preventDefault();
      
      const safeFilename = (title || 'video').replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const m3uContent = `#EXTM3U\n#EXTINF:-1,${title || 'RD Stream'}\n${url}`;
      const blob = new Blob([m3uContent], { type: 'application/vnd.apple.mpegurl' });
      const blobUrl = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${safeFilename}.m3u`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    });

  } else {
    document.getElementById('title').textContent = 'Erro: URL não fornecida.';
  }
});
