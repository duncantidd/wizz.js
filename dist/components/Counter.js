export default function mountComponent(target) {
  let isMounted = false;
  function queueUpdate(changed) {
    if (isMounted) update(ctx, changed);
  }
  // --- Developer Logic ---
  
    let count = 0;
  
    function increment() {
      count += 1; queueUpdate({ count: true });
    }
  
  
// --- Framework Context ---
  const ctx = {
    get count() { return count; },
  };
  
// --- DOM Creation ---
  function create(ctx) {
    const node_1 = document.createElement("main");
    const node_2 = document.createTextNode("\n  ");
    node_1.appendChild(node_2);
    const node_3 = document.createElement("button");
    node_3.addEventListener("click", increment);
    node_3.setAttribute("data-wizz-id", "1");
    node_1.appendChild(node_3);
    const node_4 = document.createTextNode("Clicks: ");
    node_3.appendChild(node_4);
    const node_5 = document.createTextNode(String(count));
    node_3.appendChild(node_5);
    const node_6 = document.createTextNode("\n");
    node_1.appendChild(node_6);
    return node_1;
  }
  
// --- Reactivity Engine ---
  function update(ctx, changed) {
    if (changed.count) {
      const target_1 = document.querySelector('[data-wizz-id="1"]');
      target_1.childNodes[1].nodeValue = String(count);
    }
  }
  
// --- Initialization ---
  const rootNode = create(ctx);
  target.appendChild(rootNode);
  update(ctx, { count: true });
  isMounted = true;
  
return {
    destroy() {
      target.removeChild(rootNode);
    }
  };
}