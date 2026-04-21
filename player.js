import { localizeHtmlPage, i18n } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
  localizeHtmlPage();

  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  const title = params.get('title');
  const videoElement = document.getElementById('player');

  const player = new Plyr(videoElement, {
    iconUrl: 'plyr.svg', 
    captions: { active: true, update: true, language: 'pt' }
  });

  if (title) {
    document.title = title;
    document.getElementById('title').textContent = title;
  }

  if (url) {
    player.source = {
      type: 'video',
      title: title || 'RD Manager Video',
      sources: [{ src: url }]
    };
    
    document.getElementById('btn-dl').href = url;
    
    const vlcBtn = document.getElementById('btn-vlc');
    vlcBtn.href = '#';
    vlcBtn.addEventListener('click', (e) => {
      e.preventDefault();
      
      const safeFilename = (title || i18n('defaultVideoName')).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const m3uContent = `#EXTM3U\n#EXTINF:-1,${title || i18n('defaultStreamName')}\n${url}`;
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
    document.getElementById('title').textContent = i18n('errorNoUrl');
  }

  setupSubtitleDragAndDrop(videoElement, player);
});

function setupSubtitleDragAndDrop(videoElement, plyrInstance) {
  const dropZone = document.getElementById('drop-zone');
  const dragOverlay = document.getElementById('drag-overlay');

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dragOverlay.classList.add('active');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (!e.relatedTarget || !dropZone.contains(e.relatedTarget)) {
      dragOverlay.classList.remove('active');
    }
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOverlay.classList.remove('active');

    const file = e.dataTransfer.files[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    const isSrt = fileName.endsWith('.srt');
    const isVtt = fileName.endsWith('.vtt');

    if (!isSrt && !isVtt) {
      alert(i18n('errorInvalidSubtitleFormat') || 'Formato inválido.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const buffer = event.target.result;
      const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
      let subtitleText;

      try {
        subtitleText = utf8Decoder.decode(new Uint8Array(buffer));
      } catch (err) {
        const latinDecoder = new TextDecoder('windows-1252');
        subtitleText = latinDecoder.decode(new Uint8Array(buffer));
      }

      if (isSrt) {
        subtitleText = convertSrtToVtt(subtitleText);
      }

      const blob = new Blob([subtitleText], { type: 'text/vtt;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);

      Array.from(videoElement.querySelectorAll('track')).forEach(t => t.remove());

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = file.name;
      track.srclang = 'pt';
      track.src = blobUrl;
      track.default = true;

      videoElement.appendChild(track);
      
      setTimeout(() => {
        if (plyrInstance.captions) {
          plyrInstance.captions.active = true;
        }
      }, 100);
    };

    reader.readAsArrayBuffer(file);
  });
}

function convertSrtToVtt(srtContent) {
  let vtt = 'WEBVTT\n\n';
  vtt += srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}
