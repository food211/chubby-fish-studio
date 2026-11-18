// Painting selection in normalised, top-left canvas coordinates. The overlay is DOM
// only; export, recording, sampling and history continue to read the pigment canvas.
let __mpxMask = null;
const __mpxMaskPrograms = new Map();
function __mpxMaskShader(source) {
    if (!/uniform sampler2D (?:u_canvasTexture|u_canvas|u_heatmapTexture|u_heatmap)\s*;/.test(source)) return source;
    return source.replace(/void main\s*\(\s*\)\s*\{/, `
        uniform int u_mpxCount;
        uniform vec2 u_mpxVertices[64];
        uniform vec2 u_mpxCanvas;
        uniform bool u_mpxFillActive;
        uniform sampler2D u_mpxFillClip;
        void main() {
            if (u_mpxFillActive) {
                ivec2 pixel = ivec2(gl_FragCoord.xy);
                pixel.y = textureSize(u_mpxFillClip, 0).y - 1 - pixel.y;
                if (texelFetch(u_mpxFillClip, pixel, 0).a < 0.5) discard;
            }
            if (u_mpxCount > 0) {
                vec2 p = gl_FragCoord.xy / u_mpxCanvas;
                p.y = 1.0 - p.y;
                bool inside = false;
                vec2 a = u_mpxVertices[u_mpxCount - 1];
                for (int i=0; i<64; i++) {
                    if (i >= u_mpxCount) break;
                    vec2 b = u_mpxVertices[i];
                    if ((a.y > p.y) != (b.y > p.y)) {
                        if (p.x < a.x + (p.y-a.y)*(b.x-a.x)/(b.y-a.y)) inside = !inside;
                    }
                    a = b;
                }
                if (!inside) discard;
            }`);
}
function __mpxMaskUniforms(gl, program, loc) {
    const previous = gl.getParameter(gl.CURRENT_PROGRAM);
    gl.useProgram(program);
    gl.uniform1i(loc.fillSampler, 8); // The pigment engine reserves units 0–7.
    gl.uniform1i(loc.count, __mpxMask?.length || 0);
    if (__mpxMask) {
        gl.uniform2fv(loc.vertices, new Float32Array(__mpxMask.flat()));
        gl.uniform2f(loc.canvas, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    gl.useProgram(previous);
}
function __mpxRegisterMask(gl, program) {
    const count = gl.getUniformLocation(program, 'u_mpxCount');
    if (count === null) return;
    const loc = {gl, count, fillSampler:gl.getUniformLocation(program,'u_mpxFillClip'),
        fillActive:gl.getUniformLocation(program,'u_mpxFillActive'), vertices:gl.getUniformLocation(program,'u_mpxVertices[0]'), canvas:gl.getUniformLocation(program,'u_mpxCanvas')};
    __mpxMaskPrograms.set(program, loc);
    __mpxMaskUniforms(gl, program, loc);
}
// A separate per-stroke mask intersects the user selection. Rasterising the whole
// path also supports sampled curves with more than 64 vertices.
function __mpxSetFillActive(gl, active) {
    const previous = gl.getParameter(gl.CURRENT_PROGRAM);
    for (const [program, loc] of __mpxMaskPrograms) {
        if (loc.gl !== gl || !gl.isProgram(program)) continue;
        gl.useProgram(program);
        gl.uniform1i(loc.fillActive, active ? 1 : 0);
    }
    gl.useProgram(previous);
}
function __mpxClipFill(gl, points) {
    const mask = document.createElement('canvas');
    mask.width = gl.drawingBufferWidth;
    mask.height = gl.drawingBufferHeight;
    const ctx = mask.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i=1; i<points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.fill('evenodd');
    const unit = gl.getParameter(gl.ACTIVE_TEXTURE);
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    gl.activeTexture(gl.TEXTURE8);
    const previous = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const texture = gl.createTexture();
    function release() {
        __mpxSetFillActive(gl, false);
        const current = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE8);
        gl.bindTexture(gl.TEXTURE_2D, previous);
        gl.deleteTexture(texture);
        gl.activeTexture(current);
    }
    try {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
        __mpxSetFillActive(gl, true);
        return release;
    } catch (error) {
        release();
        throw error;
    } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
        gl.activeTexture(unit);
    }
}
function __mpxSetMask(points) {
    const painter = __mpxPainter();
    if (__mpxMask && painter) {
        painter.clearWetHeatmap();
        painter.clearDepositHeatmap();
        if (painter._dripParticles) painter._dripParticles.length = 0;
    }
    __mpxMask = points;
    for (const [program, loc] of __mpxMaskPrograms) {
        if (!loc.gl.isProgram(program)) __mpxMaskPrograms.delete(program);
        else __mpxMaskUniforms(loc.gl,program,loc);
    }
    const parent = mixCanvas.parentNode;
    parent.querySelector('[data-mpx-selection]')?.remove();
    if (!points) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = mixCanvas.ownerDocument.createElementNS(svgNS,'svg');
    svg.setAttribute('data-mpx-selection','');
    svg.setAttribute('viewBox','0 0 1 1');
    svg.setAttribute('preserveAspectRatio','none');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
    for (const color of ['white','#443b60']) {
        const edge = mixCanvas.ownerDocument.createElementNS(svgNS,'polygon');
        edge.setAttribute('points',points.map(p=>p.join(',')).join(' '));
        edge.setAttribute('fill','none');edge.setAttribute('stroke',color);
        edge.setAttribute('vector-effect','non-scaling-stroke');
        if (color !== 'white') edge.setAttribute('stroke-dasharray','4 4');
        svg.appendChild(edge);
    }
    parent.appendChild(svg);
}
