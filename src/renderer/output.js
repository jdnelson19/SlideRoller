const { ipcRenderer } = require('electron');

let currentImageIndex = 0;
let isFirstImage = true;
const images = [
  document.getElementById('image1'),
  document.getElementById('image2')
];

// Set initial state - both images hidden, no transition
images[0].classList.remove('visible', 'fade');
images[1].classList.remove('visible', 'fade');

// Initialize output window
ipcRenderer.on('init-player', (event, { playerId, outputType, streamName }) => {
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
ipcRenderer.on('update-image', (event, { imagePath, transition, duration, scaleFill }) => {
  const currentImage = images[currentImageIndex];
  const nextImageIndex = (currentImageIndex + 1) % 2;
  const nextImage = images[nextImageIndex];

  // Apply scale setting to both images
  currentImage.style.objectFit = scaleFill ? 'cover' : 'contain';
  nextImage.style.objectFit = scaleFill ? 'cover' : 'contain';

  if (transition === 'crossfade') {
    // For first image, just show it without transition
    if (isFirstImage) {
      nextImage.src = `file://${imagePath}`;
      nextImage.classList.remove('fade');
      nextImage.classList.add('visible');
      currentImageIndex = nextImageIndex;
      isFirstImage = false;
      console.log('First image loaded, no transition');
    } else {
      // Subsequent images: crossfade
      const performCrossfade = () => {
        console.log(`Starting crossfade: duration=${duration}s`);
        
        // Set the transition duration dynamically
        nextImage.style.transitionDuration = `${duration}s`;
        currentImage.style.transitionDuration = `${duration}s`;
        
        // Force reflow
        void nextImage.offsetHeight;
        
        // Use requestAnimationFrame to ensure smooth transition
        requestAnimationFrame(() => {
          // Add fade class and toggle visibility
          currentImage.classList.add('fade');
          nextImage.classList.add('fade');
          
          requestAnimationFrame(() => {
            console.log('Applying crossfade');
            currentImage.classList.remove('visible');
            nextImage.classList.add('visible');
            
            // Update index after transition completes
            setTimeout(() => {
              currentImageIndex = nextImageIndex;
              console.log('Crossfade complete');
            }, duration * 1000);
          });
        });
      };
      
      // Ensure next image starts hidden
      nextImage.classList.remove('visible', 'fade');
      nextImage.src = `file://${imagePath}`;
      
      // Handle both onload (new image) and already loaded (cached image)
      if (nextImage.complete && nextImage.naturalHeight !== 0) {
        console.log('Image already loaded (cached), starting crossfade immediately');
        performCrossfade();
      } else {
        nextImage.onload = () => {
          console.log('Image loaded, starting crossfade');
          performCrossfade();
        };
      }
    }
  } else {
    // Cut transition (instant)
    currentImage.classList.remove('fade', 'visible');
    nextImage.classList.remove('fade');
    currentImage.style.transitionDuration = '0s';
    nextImage.style.transitionDuration = '0s';
    nextImage.src = `file://${imagePath}`;
    nextImage.classList.add('visible');
    currentImageIndex = nextImageIndex;
    isFirstImage = false;
  }
});

// Handle background color updates
ipcRenderer.on('update-background-color', (event, { color }) => {
  document.body.style.background = color;
});
