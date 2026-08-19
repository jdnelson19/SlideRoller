const { ipcRenderer } = require('electron');

let currentImageIndex = 0;
let isFirstImage = true;
let mediaUpdateId = 0;
let outputPlayerId = null;
const imageMedia = [document.getElementById('image1'), document.getElementById('image2')];
const videoMedia = [document.getElementById('video1'), document.getElementById('video2')];

// Set initial state - both images hidden, no transition
[...imageMedia, ...videoMedia].forEach((media) => media.classList.remove('visible', 'fade'));

// Initialize output window
ipcRenderer.on('init-player', (event, { playerId, outputType, streamName }) => {
  outputPlayerId = playerId;
  console.log(`Output window initialized for player ${playerId}`);
  console.log(`Output type: ${outputType}`);
  if (streamName) {
    console.log(`Stream name: ${streamName}`);
  }
});

// Handle image list updates from folder watcher
ipcRenderer.on('images-updated', (event, { playerId, images }) => {
  console.log(`Player ${playerId} images updated: ${images.length} images`);
  // No need to do anything special here - the main process will continue
  // sending update-image events with the new image list
});

// Handle image updates
ipcRenderer.on(
  'update-image',
  (event, { imagePath, mediaType, transition, duration, scaleFill }) => {
    const updateId = ++mediaUpdateId;
    const isVideo = mediaType === 'video';
    const mediaForType = isVideo ? videoMedia : imageMedia;
    const currentImage = document.querySelector('.output-media.visible');
    const nextImageIndex = (currentImageIndex + 1) % 2;
    const nextImage = mediaForType[nextImageIndex];

    [...imageMedia, ...videoMedia].forEach((media) => {
      if (media === nextImage || Number(media.dataset.slot) !== nextImageIndex) return;
      if (media.tagName === 'VIDEO') media.pause();
      media.classList.remove('visible', 'fade');
    });

    // Apply scale setting to both images
    if (currentImage) currentImage.style.objectFit = scaleFill ? 'cover' : 'contain';
    nextImage.style.objectFit = scaleFill ? 'cover' : 'contain';

    const setMediaSource = () => {
      nextImage.onload = null;
      nextImage.onloadeddata = null;
      nextImage.dataset.mediaPath = imagePath;
      nextImage.src = `file://${imagePath}`;
      if (isVideo) {
        nextImage.currentTime = 0;
        nextImage.load();
      }
    };

    const playVideo = () => {
      if (isVideo) {
        nextImage
          .play()
          .catch((error) => console.error(`Unable to play output video ${imagePath}:`, error));
      }
    };

    if (transition === 'crossfade') {
      // For first image, just show it without transition
      if (isFirstImage) {
        setMediaSource();
        nextImage.classList.remove('fade');
        nextImage.classList.add('visible');
        currentImageIndex = nextImageIndex;
        isFirstImage = false;
        playVideo();
        console.log('First image loaded, no transition');
      } else {
        // Subsequent images: crossfade
        const performCrossfade = () => {
          console.log(`Starting crossfade: duration=${duration}s`);

          // Set the transition duration dynamically
          nextImage.style.transitionDuration = `${duration}s`;
          if (currentImage) currentImage.style.transitionDuration = `${duration}s`;

          // Force reflow
          void nextImage.offsetHeight;

          // Use requestAnimationFrame to ensure smooth transition
          requestAnimationFrame(() => {
            // Add fade class and toggle visibility
            if (currentImage) currentImage.classList.add('fade');
            nextImage.classList.add('fade');

            requestAnimationFrame(() => {
              console.log('Applying crossfade');
              if (currentImage) currentImage.classList.remove('visible');
              nextImage.classList.add('visible');
              playVideo();

              // Update index after transition completes
              setTimeout(() => {
                if (currentImage && currentImage.tagName === 'VIDEO') currentImage.pause();
                currentImageIndex = nextImageIndex;
                console.log('Crossfade complete');
              }, duration * 1000);
            });
          });
        };

        // Ensure next image starts hidden
        nextImage.classList.remove('visible', 'fade');
        setMediaSource();

        // Handle both newly loaded and cached media.
        if (!isVideo && nextImage.complete && nextImage.naturalHeight !== 0) {
          console.log('Image already loaded (cached), starting crossfade immediately');
          performCrossfade();
        } else if (isVideo && nextImage.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          performCrossfade();
        } else {
          nextImage[isVideo ? 'onloadeddata' : 'onload'] = () => {
            if (updateId !== mediaUpdateId) return;
            console.log('Image loaded, starting crossfade');
            performCrossfade();
          };
        }
      }
    } else {
      // Cut transition (instant)
      if (currentImage) {
        if (currentImage.tagName === 'VIDEO') currentImage.pause();
        currentImage.classList.remove('fade', 'visible');
      }
      nextImage.classList.remove('fade');
      if (currentImage) currentImage.style.transitionDuration = '0s';
      nextImage.style.transitionDuration = '0s';
      setMediaSource();
      nextImage.classList.add('visible');
      currentImageIndex = nextImageIndex;
      isFirstImage = false;
      playVideo();
    }
  }
);

videoMedia.forEach((video) => {
  video.addEventListener('ended', () => {
    if (!outputPlayerId || !video.dataset.mediaPath) return;
    ipcRenderer.send('output-video-ended', {
      playerId: outputPlayerId,
      mediaPath: video.dataset.mediaPath,
    });
  });
});

// Handle background color updates
ipcRenderer.on('update-background-color', (event, { color }) => {
  document.body.style.background = color;
});
