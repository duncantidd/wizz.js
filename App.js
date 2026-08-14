export default function mountComponent(target) {
  let isMounted = false;
  function queueUpdate(changed) {
    if (isMounted) update(ctx, changed);
  }
  // --- Developer Logic ---
  
    const frameworkName = "wizz.js";
    let clicks = 0;
    
    function handleClick() {
      clicks++; queueUpdate({ clicks: true });
    }
  
    function clickme() {
      alert('Hello ' + name);
    }
  
    let name = null;
    if (!name) {
      name = "Alice"; queueUpdate({ name: true });
    }
  
  
// --- Framework Context ---
  const ctx = {
    get clicks() { return clicks; },
    get name() { return name; },
  };
  
// --- DOM Creation ---
  function create(ctx) {
    const node_1 = document.createElement("main");
    const node_2 = document.createTextNode("\n  ");
    node_1.appendChild(node_2);
    const node_3 = document.createElement("h1");
    node_3.addEventListener("click", clickme);
    node_3.setAttribute("data-wizz-id", "1");
    node_1.appendChild(node_3);
    const node_4 = document.createTextNode("Hi ");
    node_3.appendChild(node_4);
    const node_5 = document.createTextNode(String(name));
    node_3.appendChild(node_5);
    const node_6 = document.createTextNode(" Welcome to ");
    node_3.appendChild(node_6);
    const node_7 = document.createTextNode(String(frameworkName));
    node_3.appendChild(node_7);
    const node_8 = document.createTextNode("!");
    node_3.appendChild(node_8);
    const node_9 = document.createTextNode("\n  ");
    node_1.appendChild(node_9);
    const node_10 = document.createElement("p");
    node_1.appendChild(node_10);
    const node_11 = document.createTextNode("Zero dependencies. 100% compiled.");
    node_10.appendChild(node_11);
    const node_12 = document.createTextNode("\n  ");
    node_1.appendChild(node_12);
    const node_13 = document.createElement("button");
    node_13.addEventListener("click", handleClick);
    node_13.setAttribute("data-wizz-id", "2");
    node_1.appendChild(node_13);
    const node_14 = document.createTextNode("Clicks: ");
    node_13.appendChild(node_14);
    const node_15 = document.createTextNode(String(clicks));
    node_13.appendChild(node_15);
    const node_16 = document.createTextNode("\n");
    node_1.appendChild(node_16);
    return node_1;
  }
  
// --- Reactivity Engine ---
  function update(ctx, changed) {
    if (changed.name) {
      const target_1 = document.querySelector('[data-wizz-id="1"]');
      target_1.childNodes[1].nodeValue = String(name);
    }
    if (changed.clicks) {
      const target_2 = document.querySelector('[data-wizz-id="2"]');
      target_2.childNodes[1].nodeValue = String(clicks);
    }
  }
  
// --- Initialization ---
  const rootNode = create(ctx);
  target.appendChild(rootNode);
  update(ctx, { clicks: true, name: true });
  isMounted = true;
  
return {
    destroy() {
      target.removeChild(rootNode);
    }
  };
}