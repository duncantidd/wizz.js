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
    const childComponents = [];
    const mountChildren = [];
    const listUpdates = [];
    const node_1 = document.createElement("div");
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
    node_1.__wizzChildComponents = childComponents;
    node_1.__wizzMountChildren = () => mountChildren.forEach((mount) => mount());
    node_1.__wizzListUpdates = listUpdates;
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
  const childComponents = rootNode.__wizzChildComponents;
  const listUpdates = rootNode.__wizzListUpdates;
  target.appendChild(rootNode);
  rootNode.__wizzMountChildren();
  update(ctx, { count: true });
  isMounted = true;
  
return {
    destroy() {
      childComponents.forEach((component) => component.destroy());
      target.removeChild(rootNode);
    }
  };
}