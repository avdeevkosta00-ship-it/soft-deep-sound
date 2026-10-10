/**
 * Living shapes (WebGL): a large point-cloud sphere whose surface is deformed by animated
 * 3D simplex noise, and a few smaller blobs that wander slowly in random directions.
 *  • idle  — the forms breathe and ripple gently;
 *  • music — the bass swells the radius and deepens the deformation.
 * Two renderings share one shader: "dots" (a lit dot lattice, like a hologram) and
 * "spikes" (fine needles along the normals, like black metal fur).
 * Colours, blending and mode come from CSS variables of the active theme.
 */
const VS = `
precision highp float;
attribute vec3 aDir; attribute float aT; attribute float aRnd;
uniform float uTime, uAmp, uFreq, uSeed, uRadius, uPointSize, uDpr, uSpike, uSpikeLen, uPersp, uRim;
uniform vec2 uCenter, uRes; uniform mat3 uRot;
varying float vLight; varying float vDepth; varying float vMix; varying float vT;

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float field(vec3 d){
  float t=uTime;
  float n1=snoise(d*uFreq+vec3(uSeed,uSeed*1.7,t*0.21));
  float n2=snoise(d*uFreq*2.2+vec3(t*0.27,-uSeed,-t*0.15));
  return n1*0.72+n2*0.28;
}
void main(){
  vec3 d=aDir;
  float n=field(d);
  float r=1.0+n*uAmp;
  // numerical normal of the displaced surface
  vec3 tA=normalize(cross(d,abs(d.y)<0.95?vec3(0.0,1.0,0.0):vec3(1.0,0.0,0.0)));
  vec3 tB=cross(d,tA);
  float e=0.04;
  vec3 pA=normalize(d+tA*e); vec3 pB=normalize(d+tB*e);
  vec3 s0=d*r; vec3 sA=pA*(1.0+field(pA)*uAmp); vec3 sB=pB*(1.0+field(pB)*uAmp);
  vec3 nrm=normalize(cross(sA-s0,sB-s0)); if(dot(nrm,d)<0.0) nrm=-nrm;
  float len=r;
  if(uSpike>0.5){ len+=aT*uSpikeLen*(0.3+0.7*smoothstep(-0.7,0.9,n)); }
  vec3 p=uRot*(mix(d,nrm,uSpike*aT*0.35)*len);
  vec3 N=uRot*nrm;
  float persp=uPersp/(uPersp-p.z);
  vec2 px=uCenter+p.xy*uRadius*persp;
  gl_Position=vec4(px/uRes*2.0-1.0,0.0,1.0); gl_Position.y=-gl_Position.y;
  vec3 L=normalize(vec3(-0.45,0.65,0.75));
  float lam=max(dot(N,L),0.0);
  float spec=pow(max(dot(reflect(-L,N),vec3(0.0,0.0,1.0)),0.0),18.0);
  float rim=pow(1.0-abs(N.z),2.2);
  vLight=mix(0.28+0.55*lam+0.95*rim+(uSpike>0.5?0.3:0.65)*spec, 0.1+0.22*lam+1.9*pow(rim,1.4)+0.35*spec, uRim);
  vDepth=clamp((p.z+1.35)/2.7,0.0,1.0);
  vMix=clamp(0.5+0.45*N.y+0.55*n+(aRnd-0.5)*0.15,0.0,1.0);
  vT=aT;
  gl_PointSize=uPointSize*persp*uDpr*(0.6+0.7*vDepth);
}`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uC1, uC2, uC3; uniform float uSpike, uAlpha, uLightBg;
varying float vLight; varying float vDepth; varying float vMix; varying float vT;
void main(){
  float a=1.0;
  if(uSpike<0.5){ vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard; a=smoothstep(0.5,0.05,d); }
  vec3 col=vMix<0.5?mix(uC1,uC2,vMix*2.0):mix(uC2,uC3,(vMix-0.5)*2.0);
  float depthA=0.18+0.82*vDepth;
  if(uSpike>0.5){ col=mix(uC1,col,0.3+0.7*vT); a*=0.4+0.45*vT; }
  // the canvas is premultiplied: rgb already carries the coverage
  if(uLightBg>0.5){
    // light skies: coloured ink dots, denser where the surface faces the light or turns away (rim)
    float k=clamp(0.7+vLight*0.5,0.0,1.0);
    float al=a*(0.3+0.7*vDepth)*k*uAlpha;
    gl_FragColor=vec4(col*al,al);
  } else {
    float al=a*depthA*uAlpha;
    vec3 c=col*vLight*(uSpike>0.5?0.42:1.5);
    gl_FragColor=vec4(c*al,al*0.6);
  }
}`;

/* hologram landscape: a perspective grid of dots whose height is ridged noise that flows toward the viewer */
const TVS = `
precision highp float;
attribute vec2 aUV;
uniform float uTime, uAmp, uDpr, uSize, uHorizon, uFocal;
uniform vec2 uRes;
varying float vB;
${VS.slice(VS.indexOf('vec3 mod289(vec3 x)'), VS.indexOf('float field('))}
void main(){
  float x=(aUV.x-0.5)*16.0;
  float z=1.4+aUV.y*13.0;
  float wz=z+uTime*0.45;
  float n=snoise(vec3(x*0.16,wz*0.16,uTime*0.025));
  float ridge=1.0-abs(snoise(vec3(x*0.075+3.0,wz*0.075,0.0)));
  float h=(n*0.22+pow(ridge,5.0)*1.7)*uAmp;
  float y=-1.0+h;
  vec2 s=vec2(x/z,y/z)*uFocal;
  vec2 px=vec2(uRes.x*0.5+s.x,uHorizon-s.y);
  gl_Position=vec4(px/uRes*2.0-1.0,0.0,1.0); gl_Position.y=-gl_Position.y;
  float near=1.0-aUV.y;
  float crest=clamp(0.18+h*0.55,0.0,1.0);
  vB=crest*(0.3+0.7*near)*smoothstep(1.0,0.6,aUV.y)*smoothstep(0.0,0.1,aUV.x)*smoothstep(1.0,0.9,aUV.x);
  gl_PointSize=uSize*uDpr*(3.2/z+0.25);
}`;
const TFS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uC; uniform float uAlpha;
varying float vB;
void main(){
  vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard;
  float a=smoothstep(0.5,0.05,d)*vB*uAlpha;
  gl_FragColor=vec4(uC*a,a*0.6);
}`;

function fib(n) { // evenly spread directions on a sphere
  const out = new Float32Array(n * 3), g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + .5) / n * 2, r = Math.sqrt(1 - y * y), th = g * i;
    out.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3);
  }
  return out;
}

export function heroLayout(W, H) {
  const m = Math.min(W, H);
  return { x: W * .62, y: H * .56, r: m * .2 };
}

export class Shapes {
  constructor(canvas, { isPlaying, energy }) {
    this.c = canvas; this.isPlaying = isPlaying; this.energy = energy;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: true, alpha: true }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    // GPU driver reset / sleep: stop drawing, rebuild everything when the context comes back
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.geo = null; this.terrain = null; this.init(); this.lost = false; });
    this.init();
    // small companions: random slow wandering
    const R = Math.random;
    this.blobs = Array.from({ length: 5 }, (_, i) => ({
      x: [.2, .88, .4, .92, .12][i] + (R() - .5) * .06, y: [.82, .2, .9, .74, .3][i] + (R() - .5) * .06,
      ang: R() * Math.PI * 2, sp: .006 + R() * .008, size: [.085, .055, .065, .1, .05][i], seed: 3 + i * 7.3, rot: R() * 6, rs: (R() - .5) * .25
    }));
    this.t = Math.random() * 50; this.kick = 0; this.speed = .4; this.last = performance.now(); this.slow = 0;
    this.readTheme();
    addEventListener('resize', () => this.resize()); this.resize();
    const loop = (now) => {
      requestAnimationFrame(loop);
      // nothing to show behind full-screen views or a hidden window: let the GPU rest
      const b = document.body.classList;
      if (this.lost || document.documentElement.classList.contains('win-hidden') || document.hidden || b.contains('deep-open') || b.contains('visual-open')) { this.last = now; return; }
      this.frame(now);
    };
    requestAnimationFrame(loop);
  }

  /** programs + geometry (again after a lost WebGL context) */
  init() {
    const gl = this.gl;
    this.prog = this.program(VS, FS);
    this.u = {};
    for (const n of ['uTime', 'uAmp', 'uFreq', 'uSeed', 'uRadius', 'uPointSize', 'uDpr', 'uSpike', 'uSpikeLen', 'uPersp', 'uCenter', 'uRes', 'uRot', 'uC1', 'uC2', 'uC3', 'uAlpha', 'uLightBg', 'uRim'])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.a = { dir: gl.getAttribLocation(this.prog, 'aDir'), t: gl.getAttribLocation(this.prog, 'aT'), rnd: gl.getAttribLocation(this.prog, 'aRnd') };
    this.tprog = this.program(TVS, TFS);
    this.tu = {};
    for (const n of ['uTime', 'uAmp', 'uDpr', 'uSize', 'uHorizon', 'uFocal', 'uRes', 'uC', 'uAlpha']) this.tu[n] = gl.getUniformLocation(this.tprog, n);
    this.ta = gl.getAttribLocation(this.tprog, 'aUV');
    this.quality = this.quality || 1;
    this.build();
  }

  program(vs, fs) {
    const gl = this.gl, mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  /** geometry: one buffer of dots and one of spike segments, for the hero and for a blob */
  build() {
    const gl = this.gl, q = this.quality;
    // free the previous buffers when quality changes
    if (this.geo) for (const g of Object.values(this.geo)) gl.deleteBuffer(g.b);
    if (this.terrain) gl.deleteBuffer(this.terrain.b);
    const make = (n, spikes) => {
      const dirs = fib(n), stride = 5, verts = spikes ? n * 2 : n, data = new Float32Array(verts * stride);
      for (let i = 0, o = 0; i < n; i++) {
        const r = Math.random();
        for (let k = 0; k < (spikes ? 2 : 1); k++) { data.set([dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2], k, r], o); o += stride; }
      }
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return { b, count: verts };
    };
    const cols = Math.round(240 * Math.sqrt(q)), rows = Math.round(130 * Math.sqrt(q)), grid = new Float32Array(cols * rows * 2);
    for (let j = 0, o = 0; j < rows; j++) for (let i = 0; i < cols; i++) { grid[o++] = (i + (j % 2) * .5) / cols; grid[o++] = j / rows; }
    const tb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tb); gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
    this.terrain = { b: tb, count: cols * rows };
    this.geo = {
      heroDots: make(Math.round(11000 * q), false), blobDots: make(Math.round(2200 * q), false),
      heroSpikes: make(Math.round(26000 * q), true), blobSpikes: make(Math.round(3000 * q), true)
    };
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const rgb = (n, d) => (v(n) || d).split(/\s+/).map((x) => +x / 255);
    this.style = {
      mode: v('--shape-mode') || 'dots', blend: v('--shape-blend') || 'add',
      c1: rgb('--shape-c1', '79 220 255'), c2: rgb('--shape-c2', '143 123 255'), c3: rgb('--shape-c3', '255 95 210'),
      light: document.documentElement.dataset.tone === 'light'
    };
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.W = innerWidth; this.H = innerHeight;
    this.c.width = Math.round(this.W * this.dpr); this.c.height = Math.round(this.H * this.dpr);
    this.gl.viewport(0, 0, this.c.width, this.c.height);
  }

  rot(a, b) { // Ry(a) · Rx(b), column-major
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    return new Float32Array([ca, 0, -sa, sa * sb, cb, ca * sb, sa * cb, -sb, ca * cb]);
  }

  draw(geo, { x, y, r, amp, freq, seed, size, ra, rb, alpha }) {
    const gl = this.gl, u = this.u, st = this.style, spikes = st.mode === 'spikes';
    gl.bindBuffer(gl.ARRAY_BUFFER, geo.b);
    gl.enableVertexAttribArray(this.a.dir); gl.vertexAttribPointer(this.a.dir, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.a.t); gl.vertexAttribPointer(this.a.t, 1, gl.FLOAT, false, 20, 12);
    gl.enableVertexAttribArray(this.a.rnd); gl.vertexAttribPointer(this.a.rnd, 1, gl.FLOAT, false, 20, 16);
    gl.uniform2f(u.uCenter, x * this.dpr, y * this.dpr);
    gl.uniform1f(u.uRadius, r * this.dpr);
    gl.uniform1f(u.uAmp, amp); gl.uniform1f(u.uFreq, freq); gl.uniform1f(u.uSeed, seed);
    gl.uniform1f(u.uPointSize, size); gl.uniform1f(u.uAlpha, alpha);
    gl.uniform1f(u.uSpike, spikes ? 1 : 0); gl.uniform1f(u.uSpikeLen, .11 + this.kick * .1);
    gl.uniformMatrix3fv(u.uRot, false, this.rot(ra, rb));
    gl.uniform1f(u.uRim, st.mode === 'holo' ? 1 : 0);
    gl.drawArrays(spikes ? gl.LINES : gl.POINTS, 0, geo.count);
  }

  /** Obsidian: a flowing dot landscape along the bottom of the window */
  drawTerrain(H) {
    const gl = this.gl, u = this.tu;
    gl.useProgram(this.tprog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrain.b);
    gl.disableVertexAttribArray(this.a.t); gl.disableVertexAttribArray(this.a.rnd);
    gl.enableVertexAttribArray(this.ta); gl.vertexAttribPointer(this.ta, 2, gl.FLOAT, false, 8, 0);
    gl.uniform2f(u.uRes, this.c.width, this.c.height);
    gl.uniform1f(u.uTime, this.t); gl.uniform1f(u.uDpr, this.dpr); gl.uniform1f(u.uSize, 2.1);
    gl.uniform1f(u.uAmp, 1 + this.kick * .55);
    gl.uniform1f(u.uHorizon, this.c.height * .52); gl.uniform1f(u.uFocal, this.c.height * .55);
    gl.uniform3fv(u.uC, this.style.c3); gl.uniform1f(u.uAlpha, .9);
    gl.drawArrays(gl.POINTS, 0, this.terrain.count);
    gl.disableVertexAttribArray(this.ta);
  }

  frame(now) {
    const dt = Math.min(.1, (now - this.last) / 1000); this.last = now;
    // adaptive quality: if frames are consistently slow (software GL), halve the point count once
    this.slow = this.slow * .97 + (dt > .045 ? 1 : 0) * .03;
    if (this.slow > .6 && this.quality > .5) { this.quality = .5; this.slow = 0; this.build(); }
    const playing = this.isPlaying();
    this.speed += ((playing ? 1 : .35) - this.speed) * .03;
    this.t += dt * this.speed;
    const e = playing ? this.energy() : 0;
    this.kick = Math.max(this.kick * .92, e);
    const gl = this.gl, u = this.u, st = this.style, W = this.W, H = this.H;
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    if (st.blend === 'add') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // glow
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // ink
    gl.uniform2f(u.uRes, this.c.width, this.c.height);
    gl.uniform1f(u.uTime, this.t); gl.uniform1f(u.uDpr, this.dpr); gl.uniform1f(u.uPersp, 3.2);
    gl.uniform3fv(u.uC1, st.c1); gl.uniform3fv(u.uC2, st.c2); gl.uniform3fv(u.uC3, st.c3);
    gl.uniform1f(u.uLightBg, st.light ? 1 : 0);
    const spikes = st.mode === 'spikes', holo = st.mode === 'holo', m = Math.min(W, H);
    const wall = now / 1000;
    if (holo) this.drawTerrain(H);
    gl.useProgram(this.prog);

    // companions wander: heading drifts randomly, speed is slow, they turn back softly near the edges
    for (const b of this.blobs) {
      b.ang += (Math.random() - .5) * dt * 1.2;
      const mx = .06, my = .08;
      if (b.x < mx || b.x > 1 - mx || b.y < my || b.y > 1 - my) { // steer gently back inside
        const want = Math.atan2(.5 - b.y, .5 - b.x);
        let d = want - b.ang; d = Math.atan2(Math.sin(d), Math.cos(d));
        b.ang += d * Math.min(1, dt * 1.5);
      }
      const v = b.sp * (playing ? 1.3 : 1);
      b.x = Math.min(1 - mx * .5, Math.max(mx * .5, b.x + Math.cos(b.ang) * v * dt));
      b.y = Math.min(1 - my * .5, Math.max(my * .5, b.y + Math.sin(b.ang) * v * dt * W / H));
      b.rot += b.rs * dt * this.speed;
      const breath = 1 + Math.sin(wall * .9 + b.seed) * .03 + this.kick * .1;
      this.draw(spikes ? this.geo.blobSpikes : this.geo.blobDots, {
        x: b.x * W, y: b.y * H, r: b.size * m * breath, amp: holo ? .03 + this.kick * .06 : .26 + this.kick * .2, freq: 1.5, seed: b.seed,
        size: spikes ? 1 : 2, ra: b.rot + this.t * .1, rb: b.rot * .7, alpha: st.light ? .75 : .7
      });
    }
    // the hero
    const L = heroLayout(W, H);
    const breath = 1 + Math.sin(wall * 1.1) * .015 + Math.sin(wall * .41) * .008 + this.kick * .07;
    this.draw(spikes ? this.geo.heroSpikes : this.geo.heroDots, {
      x: L.x, y: holo ? L.y - L.r * .35 : L.y, r: L.r * breath, amp: holo ? .025 + this.kick * .09 : .14 + this.kick * .2 + Math.sin(this.t * .2) * .02, freq: 1.25, seed: 1.3,
      size: spikes ? 1 : holo ? 2.2 : 2.5, ra: this.t * .09, rb: .35 + Math.sin(this.t * .05) * .25, alpha: st.light ? .9 : .95
    });
  }
}
