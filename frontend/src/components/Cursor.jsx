import { useEffect, useRef } from 'react';

export default function Cursor() {
  const dot  = useRef(null);
  const ring = useRef(null);
  let rx = 0, ry = 0, mx = 0, my = 0;

  useEffect(() => {
    const move = (e) => {
      mx = e.clientX; my = e.clientY;
      dot.current.style.left = mx + 'px';
      dot.current.style.top  = my + 'px';
    };
    document.addEventListener('mousemove', move);

    let raf;
    const animate = () => {
      rx += (mx - rx) * 0.12;
      ry += (my - ry) * 0.12;
      if (ring.current) {
        ring.current.style.left = rx + 'px';
        ring.current.style.top  = ry + 'px';
      }
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      document.removeEventListener('mousemove', move);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      <div id="cursor"      ref={dot} />
      <div id="cursor-ring" ref={ring} />
    </>
  );
}