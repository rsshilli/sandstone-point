// Read by Leaflet when it loads, so this file must come before leaflet.js. It makes Leaflet place
// map tiles with plain left/top instead of 3D transforms: when the map sits at a fractional pixel
// (it does, below the text above it), Chrome draws 3D-placed tiles with faint lines between them.
window.L_DISABLE_3D = true;
