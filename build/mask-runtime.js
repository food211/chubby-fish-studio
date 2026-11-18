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
        void main() {
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
    const loc = {gl, count, vertices:gl.getUniformLocation(program,'u_mpxVertices[0]'), canvas:gl.getUniformLocation(program,'u_mpxCanvas')};
    __mpxMaskPrograms.set(program, loc);
    __mpxMaskUniforms(gl, program, loc);
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
