import { useEffect, useRef } from 'react';

export default function ThreeBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!window.THREE) return;
    const THREE    = window.THREE;
    const canvas   = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x030712, 1);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
    camera.position.z = 5;

    // Particles
    const N = 1800, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const C = [[0,.96,.83],[.48,.37,.65],[.98,.75,.14],[.2,.2,.3]];
    for (let i = 0; i < N; i++) {
      pos[i*3]   = (Math.random()-.5)*22;
      pos[i*3+1] = (Math.random()-.5)*14;
      pos[i*3+2] = (Math.random()-.5)*12-3;
      const c = C[Math.random()<.3?0:Math.random()<.15?1:Math.random()<.1?2:3];
      col[i*3]=c[0]; col[i*3+1]=c[1]; col[i*3+2]=c[2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size:.06, vertexColors:true, transparent:true, opacity:.75 }));
    scene.add(pts);

    const tor = new THREE.Mesh(
      new THREE.TorusGeometry(2.5,.8,16,60),
      new THREE.MeshBasicMaterial({ color:0x00f5d4, wireframe:true, transparent:true, opacity:.04 })
    );
    tor.position.set(3,-1,0); scene.add(tor);

    const grid = new THREE.GridHelper(40,40,0x00f5d4,0x0a1628);
    grid.position.y = -3.5; grid.material.transparent = true; grid.material.opacity = .12;
    scene.add(grid);

    let mx2=0, my2=0;
    const onMove = e => { mx2=(e.clientX/innerWidth-.5)*2; my2=(e.clientY/innerHeight-.5)*2; };
    document.addEventListener('mousemove', onMove);

    const onResize = () => {
      camera.aspect = innerWidth/innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    };
    window.addEventListener('resize', onResize);

    let t = 0, raf;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      t += .004;
      pts.rotation.y = t*.05; tor.rotation.x = t*.3; tor.rotation.y = t*.15;
      grid.position.z = (t*.5)%1;
      camera.position.x += (mx2*.3 - camera.position.x)*.03;
      camera.position.y += (-my2*.2 - camera.position.y)*.03;
      camera.lookAt(0,0,0);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position:'fixed', inset:0, zIndex:0, pointerEvents:'none' }}
    />
  );
}