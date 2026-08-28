import Counter from "../components/Counter.js";

export default function mountComponent(target) {
  let isMounted = false;
  function queueUpdate(changed) {
    if (isMounted) update(ctx, changed);
  }
  // --- Developer Logic ---
  
      const section = "About";
  
  
// --- Framework Context ---
  const ctx = {
  };
  
// --- DOM Creation ---
  function create(ctx) {
    const childComponents = [];
    const mountChildren = [];
    const node_1 = document.createElement("main");
    const node_2 = document.createTextNode("\n  ");
    node_1.appendChild(node_2);
    const node_3 = document.createElement("h1");
    node_1.appendChild(node_3);
    const node_4 = document.createTextNode("The ");
    node_3.appendChild(node_4);
    const node_5 = document.createTextNode(String(section));
    node_3.appendChild(node_5);
    const node_6 = document.createTextNode(" section!");
    node_3.appendChild(node_6);
    const node_7 = document.createTextNode("\n  ");
    node_1.appendChild(node_7);
    const node_8 = document.createElement("p");
    node_1.appendChild(node_8);
    const node_9 = document.createTextNode("Lets build something. How about a counter?");
    node_8.appendChild(node_9);
    const node_10 = document.createTextNode("\n  ");
    node_1.appendChild(node_10);
    if (section === 'About') {
      const node_11 = document.createTextNode("\n    ");
      node_1.appendChild(node_11);
      const node_12 = document.createElement("p");
      node_1.appendChild(node_12);
      const node_13 = document.createTextNode("The counter will be rendered below");
      node_12.appendChild(node_13);
      const node_14 = document.createTextNode("\n  ");
      node_1.appendChild(node_14);
    }
    const node_15 = document.createTextNode("\n  ");
    node_1.appendChild(node_15);
    mountChildren.push(() => childComponents.push(Counter(node_1)));
    const node_17 = document.createTextNode("\n");
    node_1.appendChild(node_17);
    node_1.__wizzChildComponents = childComponents;
    node_1.__wizzMountChildren = () => mountChildren.forEach((mount) => mount());
    return node_1;
  }
  
// --- Reactivity Engine ---
  function update(ctx, changed) {
  }
  
// --- Initialization ---
  const rootNode = create(ctx);
  const childComponents = rootNode.__wizzChildComponents;
  target.appendChild(rootNode);
  rootNode.__wizzMountChildren();
  update(ctx, {  });
  isMounted = true;
  
return {
    destroy() {
      childComponents.forEach((component) => component.destroy());
      target.removeChild(rootNode);
    }
  };
}