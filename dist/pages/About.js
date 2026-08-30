import Counter from "../components/Counter.js";

export default function mountComponent(target) {
  let isMounted = false;
  function queueUpdate(changed) {
    if (isMounted) update(ctx, changed);
  }
  // --- Developer Logic ---
  
      const section = "About";
      const fruits = [
        { id: 'apple', name: 'Apple' },
        { id: 'orange', name: 'Orange' },
        { id: 'pear', name: 'Pear' }
      ];
  
  
// --- Framework Context ---
  const ctx = {
  };
  
// --- DOM Creation ---
  function create(ctx) {
    const childComponents = [];
    const mountChildren = [];
    const listUpdates = [];
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
      const node_14 = document.createTextNode("\n    ");
      node_1.appendChild(node_14);
      mountChildren.push(() => childComponents.push(Counter(node_1)));
      const node_16 = document.createTextNode("\n  ");
      node_1.appendChild(node_16);
    } else {
      const node_17 = document.createTextNode("\n    ");
      node_1.appendChild(node_17);
      const node_18 = document.createElement("ul");
      node_1.appendChild(node_18);
      const node_19 = document.createTextNode("\n      ");
      node_18.appendChild(node_19);
      const anchor_20 = document.createTextNode("");
      node_18.appendChild(anchor_20);
      const records_20 = new Map();
      function createItem_20(fruit) {
        const node_21 = document.createElement("li");
        const node_22 = document.createTextNode(String(fruit.name));
        node_21.appendChild(node_22);
        return {
          node: node_21,
          update(fruit) {
            node_21.childNodes[0].nodeValue = String(fruit.name);
          }
        };
      }
      function updateList_20(items) {
        const nextRecords = new Map();
        const seenKeys = new Set();
        items.forEach((fruit) => {
          const key = fruit.id;
          if (seenKeys.has(key)) throw new Error("Each block keys must be unique.");
          seenKeys.add(key);
          let record = records_20.get(key);
          if (record) record.update(fruit);
          else record = createItem_20(fruit);
          node_18.insertBefore(record.node, anchor_20);
          nextRecords.set(key, record);
        });
        records_20.forEach((record, key) => { if (!nextRecords.has(key)) node_18.removeChild(record.node); });
        records_20.clear();
        nextRecords.forEach((record, key) => records_20.set(key, record));
      }
      updateList_20(fruits);
      listUpdates.push((changed) => { if (changed.fruits) updateList_20(fruits); });
      const node_23 = document.createTextNode("\n    ");
      node_18.appendChild(node_23);
      const node_24 = document.createTextNode("\n  ");
      node_1.appendChild(node_24);
    }
    const node_25 = document.createTextNode("\n");
    node_1.appendChild(node_25);
    node_1.__wizzChildComponents = childComponents;
    node_1.__wizzMountChildren = () => mountChildren.forEach((mount) => mount());
    node_1.__wizzListUpdates = listUpdates;
    return node_1;
  }
  
// --- Reactivity Engine ---
  function update(ctx, changed) {
    listUpdates.forEach((updateList) => updateList(changed));
  }
  
// --- Initialization ---
  const rootNode = create(ctx);
  const childComponents = rootNode.__wizzChildComponents;
  const listUpdates = rootNode.__wizzListUpdates;
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