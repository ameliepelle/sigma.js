/**
 * Sigma.js
 * ========
 * @module
 */
import { EventEmitter } from "events";
import graphExtent from "graphology-metrics/extent";
import Graph from "graphology";

import Camera from "./core/camera";
import MouseCaptor from "./core/captors/mouse";
import QuadTree from "./core/quadtree";
import {
  CameraState,
  Coordinates,
  Dimensions,
  EdgeDisplayData,
  Extent,
  Listener,
  MouseCoords,
  NodeDisplayData,
  PlainObject,
} from "./types";
import {
  createElement,
  getPixelRatio,
  createNormalizationFunction,
  NormalizationFunction,
  assignDeep,
  cancelFrame,
  matrixFromCamera,
  requestFrame,
  validateGraph,
  zIndexOrdering,
} from "./utils";
import { edgeLabelsToDisplayFromNodes, LabelGrid } from "./core/labels";
import { Settings, DEFAULT_SETTINGS, validateSettings } from "./settings";
import { INodeProgram } from "./rendering/webgl/programs/common/node";
import { IEdgeProgram } from "./rendering/webgl/programs/common/edge";
import TouchCaptor from "./core/captors/touch";
import { identity, multiplyVec } from "./utils/matrices";

const { nodeExtent } = graphExtent;

/**
 * Constants.
 */
const PIXEL_RATIO = getPixelRatio();
const WEBGL_OVERSAMPLING_RATIO = getPixelRatio();
const SIZE_SCALING_EXPONENT = 0.5;

/**
 * Important functions.
 */
function applyNodeDefaults(settings: Settings, key: string, data: Partial<NodeDisplayData>): NodeDisplayData {
  if (!data.hasOwnProperty("x") || !data.hasOwnProperty("y"))
    throw new Error(
      `Sigma: could not find a valid position (x, y) for node "${key}". All your nodes must have a number "x" and "y". Maybe your forgot to apply a layout or your "nodeReducer" is not returning the correct data?`,
    );

  if (!data.color) data.color = settings.defaultNodeColor;

  if (!data.label && data.label !== "") data.label = null;

  if (data.label !== undefined && data.label !== null) data.label = "" + data.label;
  else data.label = null;

  if (!data.size) data.size = 2;

  if (!data.hasOwnProperty("hidden")) data.hidden = false;

  if (!data.hasOwnProperty("highlighted")) data.highlighted = false;

  if (!data.type || data.type === "") data.type = settings.defaultNodeType;

  if (!data.zIndex) data.zIndex = 0;

  return data as NodeDisplayData;
}

function applyEdgeDefaults(settings: Settings, key: string, data: Partial<EdgeDisplayData>): EdgeDisplayData {
  if (!data.color) data.color = settings.defaultEdgeColor;

  if (!data.label) data.label = "";

  if (!data.size) data.size = 0.5;

  if (!data.hasOwnProperty("hidden")) data.hidden = false;

  if (!data.type || data.type === "") data.type = settings.defaultEdgeType;

  if (!data.zIndex) data.zIndex = 0;

  return data as EdgeDisplayData;
}

/**
 * Main class.
 *
 * @constructor
 * @param {Graph}       graph     - Graph to render.
 * @param {HTMLElement} container - DOM container in which to render.
 * @param {object}      settings  - Optional settings.
 */
export default class Sigma extends EventEmitter {
  private settings: Settings;
  private graph: Graph;
  private mouseCaptor: MouseCaptor;
  private touchCaptor: TouchCaptor;
  private container: HTMLElement;
  private elements: PlainObject<HTMLCanvasElement> = {};
  private canvasContexts: PlainObject<CanvasRenderingContext2D> = {};
  private webGLContexts: PlainObject<WebGLRenderingContext> = {};
  private activeListeners: PlainObject<Listener> = {};
  private quadtree: QuadTree = new QuadTree();
  private labelGrid: LabelGrid = new LabelGrid();
  private nodeDataCache: Record<string, NodeDisplayData> = {};
  private edgeDataCache: Record<string, EdgeDisplayData> = {};
  private nodeKeyToIndex: Record<string, number> = {};
  private edgeKeyToIndex: Record<string, number> = {};
  private nodeExtent: { x: Extent; y: Extent } = { x: [0, 1], y: [0, 1] };

  private matrix: Float32Array = identity();
  private invMatrix: Float32Array = identity();
  private customBBox: { x: Extent; y: Extent } | null = null;
  private normalizationFunction: NormalizationFunction = createNormalizationFunction({
    x: [-Infinity, Infinity],
    y: [-Infinity, Infinity],
  });

  // Cache:
  private cameraSizeRatio = 1;

  // Starting dimensions
  private width = 0;
  private height = 0;

  // State
  private displayedLabels: Set<string> = new Set();
  private highlightedNodes: Set<string> = new Set();
  private hoveredNode: string | null = null;
  private renderFrame: number | null = null;
  private renderHighlightedNodesFrame: number | null = null;
  private needToProcess = false;
  private needToSoftProcess = false;

  // programs
  private nodePrograms: { [key: string]: INodeProgram } = {};
  private hoverNodePrograms: { [key: string]: INodeProgram } = {};
  private edgePrograms: { [key: string]: IEdgeProgram } = {};

  private camera: Camera;

  constructor(graph: Graph, container: HTMLElement, settings: Partial<Settings> = {}) {
    super();

    this.settings = assignDeep<Settings>({}, DEFAULT_SETTINGS, settings);

    // Validating
    validateSettings(this.settings);
    validateGraph(graph);
    if (!(container instanceof HTMLElement)) throw new Error("Sigma: container should be an html element.");

    // Properties
    this.graph = graph;
    this.container = container;

    this.initializeCache();

    // Initializing contexts
    this.createWebGLContext("edges");
    this.createWebGLContext("nodes");
    this.createCanvasContext("edgeLabels");
    this.createCanvasContext("labels");
    this.createCanvasContext("hovers");
    this.createWebGLContext("hoverNodes");
    this.createCanvasContext("mouse");

    // Blending
    let gl = this.webGLContexts.nodes;

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    gl = this.webGLContexts.edges;

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    // Loading programs
    for (const type in this.settings.nodeProgramClasses) {
      const NodeProgramClass = this.settings.nodeProgramClasses[type];
      this.nodePrograms[type] = new NodeProgramClass(this.webGLContexts.nodes, this);
      this.hoverNodePrograms[type] = new NodeProgramClass(this.webGLContexts.hoverNodes, this);
    }
    for (const type in this.settings.edgeProgramClasses) {
      const EdgeProgramClass = this.settings.edgeProgramClasses[type];
      this.edgePrograms[type] = new EdgeProgramClass(this.webGLContexts.edges, this);
    }

    // Initial resize
    this.resize();

    // Initializing the camera
    this.camera = new Camera();

    // Binding camera events
    this.bindCameraHandlers();

    // Initializing captors
    this.mouseCaptor = new MouseCaptor(this.elements.mouse, this);
    this.touchCaptor = new TouchCaptor(this.elements.mouse, this);

    // Binding event handlers
    this.bindEventHandlers();

    // Binding graph handlers
    this.bindGraphHandlers();

    // Processing data for the first time & render
    this.process();
    this.render();
  }

  /**---------------------------------------------------------------------------
   * Internal methods.
   **---------------------------------------------------------------------------
   */

  /**
   * Internal function used to create a canvas element.
   * @param  {string} id - Context's id.
   * @return {Sigma}
   */
  private createCanvas(id: string): HTMLCanvasElement {
    const canvas: HTMLCanvasElement = createElement<HTMLCanvasElement>(
      "canvas",
      {
        position: "absolute",
      },
      {
        class: `sigma-${id}`,
      },
    );

    this.elements[id] = canvas;
    this.container.appendChild(canvas);

    return canvas;
  }

  /**
   * Internal function used to create a canvas context and add the relevant
   * DOM elements.
   *
   * @param  {string} id - Context's id.
   * @return {Sigma}
   */
  private createCanvasContext(id: string): this {
    const canvas = this.createCanvas(id);

    const contextOptions = {
      preserveDrawingBuffer: false,
      antialias: false,
    };

    this.canvasContexts[id] = canvas.getContext("2d", contextOptions) as CanvasRenderingContext2D;

    return this;
  }

  /**
   * Internal function used to create a canvas context and add the relevant
   * DOM elements.
   *
   * @param  {string} id - Context's id.
   * @return {Sigma}
   */
  private createWebGLContext(id: string): this {
    const canvas = this.createCanvas(id);

    const contextOptions = {
      preserveDrawingBuffer: false,
      antialias: false,
    };

    let context;

    // First we try webgl2 for an easy performance boost
    context = canvas.getContext("webgl2", contextOptions);

    // Else we fall back to webgl
    if (!context) context = canvas.getContext("webgl", contextOptions);

    // Edge, I am looking right at you...
    if (!context) context = canvas.getContext("experimental-webgl", contextOptions);

    this.webGLContexts[id] = context as WebGLRenderingContext;

    return this;
  }

  /**
   * Method used to initialize display data cache.
   *
   * @return {Sigma}
   */
  private initializeCache(): void {
    const graph = this.graph;

    // NOTE: the data caches are never reset to avoid paying a GC cost
    // But this could prove to be a bad decision. In which case just "reset"
    // them here.

    let i = 0;

    graph.forEachNode((key) => {
      this.nodeKeyToIndex[key] = i++;
    });

    i = 0;

    graph.forEachEdge((key) => {
      this.edgeKeyToIndex[key] = i++;
    });
  }

  /**
   * Method binding camera handlers.
   *
   * @return {Sigma}
   */
  private bindCameraHandlers(): this {
    this.activeListeners.camera = () => {
      this._scheduleRefresh();
    };

    this.camera.on("updated", this.activeListeners.camera);

    return this;
  }

  /**
   * Method binding event handlers.
   *
   * @return {Sigma}
   */
  private bindEventHandlers(): this {
    // Handling window resize
    this.activeListeners.handleResize = () => {
      this.needToSoftProcess = true;
      this._scheduleRefresh();
    };

    window.addEventListener("resize", this.activeListeners.handleResize);

    // Function checking if the mouse is on the given node
    const mouseIsOnNode = (mouseX: number, mouseY: number, nodeX: number, nodeY: number, size: number): boolean => {
      return (
        mouseX > nodeX - size &&
        mouseX < nodeX + size &&
        mouseY > nodeY - size &&
        mouseY < nodeY + size &&
        Math.sqrt(Math.pow(mouseX - nodeX, 2) + Math.pow(mouseY - nodeY, 2)) < size
      );
    };

    // Function returning the nodes in the mouse's quad
    const getQuadNodes = (mouseX: number, mouseY: number) => {
      const mouseGraphPosition = this.viewportToFramedGraph({ x: mouseX, y: mouseY });

      // TODO: minus 1? lol
      return this.quadtree.point(mouseGraphPosition.x, 1 - mouseGraphPosition.y);
    };

    // Handling mouse move
    this.activeListeners.handleMove = (e: Coordinates): void => {
      // NOTE: for the canvas renderer, testing the pixel's alpha should
      // give some boost but this slows things down for WebGL empirically.

      const quadNodes = getQuadNodes(e.x, e.y);

      // We will hover the node whose center is closest to mouse
      let minDistance = Infinity,
        nodeToHover = null;

      for (let i = 0, l = quadNodes.length; i < l; i++) {
        const node = quadNodes[i];

        const data = this.nodeDataCache[node];

        const pos = this.framedGraphToViewport(data);

        const size = this.scaleSize(data.size);

        if (mouseIsOnNode(e.x, e.y, pos.x, pos.y, size)) {
          const distance = Math.sqrt(Math.pow(e.x - pos.x, 2) + Math.pow(e.y - pos.y, 2));

          // TODO: sort by min size also for cases where center is the same
          if (distance < minDistance) {
            minDistance = distance;
            nodeToHover = node;
          }
        }
      }

      if (nodeToHover && this.hoveredNode !== nodeToHover && !this.nodeDataCache[nodeToHover].hidden) {
        // Handling passing from one node to the other directly
        if (this.hoveredNode) this.emit("leaveNode", { node: this.hoveredNode });

        this.hoveredNode = nodeToHover;
        this.emit("enterNode", { node: nodeToHover });
        this.scheduleHighlightedNodesRender();
        return;
      }

      // Checking if the hovered node is still hovered
      if (this.hoveredNode) {
        const data = this.nodeDataCache[this.hoveredNode];

        const pos = this.framedGraphToViewport(data);

        const size = this.scaleSize(data.size);

        if (!mouseIsOnNode(e.x, e.y, pos.x, pos.y, size)) {
          const node = this.hoveredNode;
          this.hoveredNode = null;

          this.emit("leaveNode", { node });
          return this.scheduleHighlightedNodesRender();
        }
      }
    };

    // Handling click
    const createClickListener = (eventType: string): ((e: MouseCoords) => void) => {
      return (e) => {
        const quadNodes = getQuadNodes(e.x, e.y);

        for (let i = 0, l = quadNodes.length; i < l; i++) {
          const node = quadNodes[i];

          const data = this.nodeDataCache[node];

          const pos = this.framedGraphToViewport(data);

          const size = this.scaleSize(data.size);

          if (mouseIsOnNode(e.x, e.y, pos.x, pos.y, size))
            return this.emit(`${eventType}Node`, { node, captor: e, event: e });
        }

        return this.emit(`${eventType}Stage`, { event: e });
      };
    };

    this.activeListeners.handleClick = createClickListener("click");
    this.activeListeners.handleRightClick = createClickListener("rightClick");
    this.activeListeners.handleDown = createClickListener("down");

    this.mouseCaptor.on("mousemove", this.activeListeners.handleMove);
    this.mouseCaptor.on("click", this.activeListeners.handleClick);
    this.mouseCaptor.on("rightClick", this.activeListeners.handleRightClick);
    this.mouseCaptor.on("mousedown", this.activeListeners.handleDown);

    // TODO
    // Deal with Touch captor events

    return this;
  }

  /**
   * Method binding graph handlers
   *
   * @return {Sigma}
   */
  private bindGraphHandlers(): this {
    const graph = this.graph;

    this.activeListeners.graphUpdate = () => {
      this.needToProcess = true;
      this._scheduleRefresh();
    };

    this.activeListeners.softGraphUpdate = () => {
      this.needToSoftProcess = true;
      this._scheduleRefresh();
    };

    this.activeListeners.addNodeGraphUpdate = (e: { key: string }): void => {
      // Adding entry to cache
      this.nodeKeyToIndex[e.key] = graph.order - 1;
      this.activeListeners.graphUpdate();
    };

    this.activeListeners.addEdgeGraphUpdate = (e: { key: string }): void => {
      // Adding entry to cache
      this.nodeKeyToIndex[e.key] = graph.order - 1;
      this.activeListeners.graphUpdate();
    };

    // TODO: clean cache on drop!

    // TODO: bind this on composed state events
    // TODO: it could be possible to update only specific node etc. by holding
    // a fixed-size pool of updated items
    graph.on("nodeAdded", this.activeListeners.addNodeGraphUpdate);
    graph.on("nodeDropped", this.activeListeners.graphUpdate);
    graph.on("nodeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.on("eachNodeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.on("edgeAdded", this.activeListeners.addEdgeGraphUpdate);
    graph.on("edgeDropped", this.activeListeners.graphUpdate);
    graph.on("edgeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.on("eachEdgeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.on("edgesCleared", this.activeListeners.graphUpdate);
    graph.on("cleared", this.activeListeners.graphUpdate);

    return this;
  }

  /**
   * Method used to process the whole graph's data.
   *
   * @return {Sigma}
   */
  private process(keepArrays = false): this {
    const graph = this.graph;
    const settings = this.settings;
    const dimensions = this.getDimensions();

    const nodeZExtent: [number, number] = [Infinity, -Infinity];
    const edgeZExtent: [number, number] = [Infinity, -Infinity];

    // Clearing the quad
    this.quadtree.clear();

    // Resetting the label grid
    // TODO: it's probably better to do this explicitly or on resizes for layout and anims
    this.labelGrid.resizeAndClear(dimensions, settings.labelGridCellSize);

    // Clear the highlightedNodes
    this.highlightedNodes = new Set();

    // Computing extents
    const nodeExtentProperties = ["x", "y"];

    this.nodeExtent = nodeExtent(graph, nodeExtentProperties) as { x: Extent; y: Extent };

    // NOTE: it is important to compute this matrix after computing the node's extent
    // because #.getGraphDimensions relies on it
    const nullCamera = new Camera();
    const nullCameraMatrix = matrixFromCamera(
      nullCamera.getState(),
      this.getDimensions(),
      this.getGraphDimensions(),
      this.getSetting("stagePadding") || 0,
    );

    // Rescaling function
    this.normalizationFunction = createNormalizationFunction(this.customBBox || this.nodeExtent);

    const nodesPerPrograms: Record<string, number> = {};

    let nodes = graph.nodes();

    for (let i = 0, l = nodes.length; i < l; i++) {
      const node = nodes[i];

      // Node display data resolution:
      //   1. First we get the node's attributes
      //   2. We optionally reduce them using the function provided by the user
      //      Note that this function must return a total object and won't be merged
      //   3. We apply our defaults, while running some vital checks
      //   4. We apply the normalization function

      // We shallow copy node data to avoid dangerous behaviors from reducers
      let attr = Object.assign({}, graph.getNodeAttributes(node));

      if (settings.nodeReducer) attr = settings.nodeReducer(node, attr);

      const data = applyNodeDefaults(this.settings, node, attr);

      nodesPerPrograms[data.type] = (nodesPerPrograms[data.type] || 0) + 1;
      this.nodeDataCache[node] = data;

      this.normalizationFunction.applyTo(data);

      if (this.settings.zIndex) {
        if (data.zIndex < nodeZExtent[0]) nodeZExtent[0] = data.zIndex;
        if (data.zIndex > nodeZExtent[1]) nodeZExtent[1] = data.zIndex;
      }
    }

    for (const type in nodesPerPrograms) {
      if (!this.nodePrograms.hasOwnProperty(type)) {
        throw new Error(`Sigma: could not find a suitable program for node type "${type}"!`);
      }

      if (!keepArrays) this.nodePrograms[type].allocate(nodesPerPrograms[type]);
      // We reset that count here, so that we can reuse it while calling the Program#process methods:
      nodesPerPrograms[type] = 0;
    }

    // Handling node z-index
    // TODO: z-index needs us to compute display data before hand
    if (this.settings.zIndex && nodeZExtent[0] !== nodeZExtent[1])
      nodes = zIndexOrdering<string>(nodeZExtent, (node: string): number => this.nodeDataCache[node].zIndex, nodes);

    for (let i = 0, l = nodes.length; i < l; i++) {
      const node = nodes[i];
      const data = this.nodeDataCache[node];

      this.quadtree.add(node, data.x, 1 - data.y, data.size / this.width);

      if (data.label)
        this.labelGrid.add(node, data.size, this.framedGraphToViewport(data, { matrix: nullCameraMatrix }));

      this.nodePrograms[data.type].process(data, data.hidden, nodesPerPrograms[data.type]++);

      // Save the node in the highlighted set if needed
      if (data.highlighted && !data.hidden) this.highlightedNodes.add(node);

      this.nodeKeyToIndex[node] = i;
    }

    this.labelGrid.organize();

    const edgesPerPrograms: Record<string, number> = {};

    let edges = graph.edges();

    for (let i = 0, l = edges.length; i < l; i++) {
      const edge = edges[i];

      // Edge display data resolution:
      //   1. First we get the edge's attributes
      //   2. We optionally reduce them using the function provided by the user
      //      Note that this function must return a total object and won't be merged
      //   3. We apply our defaults, while running some vital checks

      // We shallow copy edge data to avoid dangerous behaviors from reducers
      let attr = Object.assign({}, graph.getEdgeAttributes(edge));

      if (settings.edgeReducer) attr = settings.edgeReducer(edge, attr);

      const data = applyEdgeDefaults(this.settings, edge, attr);

      edgesPerPrograms[data.type] = (edgesPerPrograms[data.type] || 0) + 1;
      this.edgeDataCache[edge] = data;

      if (this.settings.zIndex) {
        if (data.zIndex < edgeZExtent[0]) edgeZExtent[0] = data.zIndex;
        if (data.zIndex > edgeZExtent[1]) edgeZExtent[1] = data.zIndex;
      }
    }

    for (const type in edgesPerPrograms) {
      if (!this.edgePrograms.hasOwnProperty(type)) {
        throw new Error(`Sigma: could not find a suitable program for edge type "${type}"!`);
      }

      if (!keepArrays) this.edgePrograms[type].allocate(edgesPerPrograms[type]);
      // We reset that count here, so that we can reuse it while calling the Program#process methods:
      edgesPerPrograms[type] = 0;
    }

    // Handling edge z-index
    if (this.settings.zIndex && edgeZExtent[0] !== edgeZExtent[1])
      edges = zIndexOrdering(edgeZExtent, (edge: string): number => this.edgeDataCache[edge].zIndex, edges);

    for (let i = 0, l = edges.length; i < l; i++) {
      const edge = edges[i];
      const data = this.edgeDataCache[edge];

      const extremities = graph.extremities(edge),
        sourceData = this.nodeDataCache[extremities[0]],
        targetData = this.nodeDataCache[extremities[1]];

      const hidden = data.hidden || sourceData.hidden || targetData.hidden;
      this.edgePrograms[data.type].process(sourceData, targetData, data, hidden, edgesPerPrograms[data.type]++);

      this.nodeKeyToIndex[edge] = i;
    }

    for (const type in this.edgePrograms) {
      const program = this.edgePrograms[type];

      if (!keepArrays && typeof program.computeIndices === "function") program.computeIndices();
    }

    return this;
  }

  /**
   * Method that decides whether to reprocess graph or not, and then render the
   * graph.
   *
   * @return {Sigma}
   */
  private _refresh(): this {
    // Do we need to process data?
    if (this.needToProcess) {
      this.process();
    } else if (this.needToSoftProcess) {
      this.process(true);
    }

    // Resetting state
    this.needToProcess = false;
    this.needToSoftProcess = false;

    // Rendering
    this.render();

    return this;
  }

  /**
   * Method that schedules a `_refresh` call if none has been scheduled yet. It
   * will then be processed next available frame.
   *
   * @return {Sigma}
   */
  private _scheduleRefresh(): this {
    if (!this.renderFrame) {
      this.renderFrame = requestFrame(() => {
        this._refresh();
        this.renderFrame = null;
      });
    }

    return this;
  }

  /**
   * Method used to render labels.
   *
   * @return {Sigma}
   */
  private renderLabels(): this {
    if (!this.settings.renderLabels) return this;

    const cameraState = this.camera.getState();

    // Finding visible nodes to display their labels
    let visibleNodes: Set<string>;

    if (cameraState.ratio >= 1) {
      // Camera is unzoomed so no need to ask the quadtree for visible nodes
      visibleNodes = new Set(this.graph.nodes());
    } else {
      // Let's ask the quadtree
      const viewRectangle = this.viewRectangle();

      visibleNodes = new Set(
        this.quadtree.rectangle(
          viewRectangle.x1,
          1 - viewRectangle.y1,
          viewRectangle.x2,
          1 - viewRectangle.y2,
          viewRectangle.height,
        ),
      );
    }

    // Selecting labels to draw
    // TODO: drop gridsettings likewise
    // TODO: optimize through visible nodes
    const labelsToDisplay = this.labelGrid.getLabelsToDisplay(cameraState.ratio, this.settings.labelDensity);
    this.displayedLabels = new Set();

    // Drawing labels
    const context = this.canvasContexts.labels;

    for (let i = 0, l = labelsToDisplay.length; i < l; i++) {
      const node = labelsToDisplay[i];
      const data = this.nodeDataCache[node];

      // If the node is hidden, we don't need to display its label obviously
      if (data.hidden) continue;

      const { x, y } = this.framedGraphToViewport(data);

      // TODO: we can cache the labels we need to render until the camera's ratio changes
      // TODO: this should be computed in the canvas components?
      const size = this.scaleSize(data.size);

      if (size < this.settings.labelRenderedSizeThreshold) continue;

      if (!visibleNodes.has(node)) continue;

      // TODO:
      // Because displayed edge labels depend directly on actually rendered node
      // labels, we need to only add to this.displayedLabels nodes whose label
      // is rendered.
      // This makes this.displayedLabels depend on viewport, which might become
      // an issue once we start memoizing getLabelsToDisplay.
      this.displayedLabels.add(node);

      this.settings.labelRenderer(
        context,
        {
          key: node,
          label: data.label,
          color: "#000",
          size,
          x,
          y,
        },
        this.settings,
      );
    }

    return this;
  }

  /**
   * Method used to render edge labels, based on which node labels were
   * rendered.
   *
   * @return {Sigma}
   */
  private renderEdgeLabels(): this {
    if (!this.settings.renderEdgeLabels) return this;

    const context = this.canvasContexts.edgeLabels;

    // Clearing
    context.clearRect(0, 0, this.width, this.height);

    const edgeLabelsToDisplay = edgeLabelsToDisplayFromNodes({
      graph: this.graph,
      hoveredNode: this.hoveredNode,
      displayedNodeLabels: this.displayedLabels,
      highlightedNodes: this.highlightedNodes,
    });

    for (let i = 0, l = edgeLabelsToDisplay.length; i < l; i++) {
      const edge = edgeLabelsToDisplay[i],
        extremities = this.graph.extremities(edge),
        sourceData = this.nodeDataCache[extremities[0]],
        targetData = this.nodeDataCache[extremities[1]],
        edgeData = this.edgeDataCache[edgeLabelsToDisplay[i]];

      // If the edge is hidden we don't need to display its label
      // NOTE: the test on sourceData & targetData is probably paranoid at this point?
      if (edgeData.hidden || sourceData.hidden || targetData.hidden) {
        continue;
      }

      const { x: sourceX, y: sourceY } = this.framedGraphToViewport(sourceData);
      const { x: targetX, y: targetY } = this.framedGraphToViewport(targetData);

      // TODO: we can cache the labels we need to render until the camera's ratio changes
      // TODO: this should be computed in the canvas components?
      const size = this.scaleSize(edgeData.size);

      this.settings.edgeLabelRenderer(
        context,
        {
          key: edge,
          label: edgeData.label,
          color: edgeData.color,
          size,
        },
        {
          key: extremities[0],
          x: sourceX,
          y: sourceY,
        },
        {
          key: extremities[1],
          x: targetX,
          y: targetY,
        },
        this.settings,
      );
    }

    return this;
  }

  /**
   * Method used to render the highlighted nodes.
   *
   * @return {Sigma}
   */
  private renderHighlightedNodes(): void {
    const context = this.canvasContexts.hovers;

    // Clearing
    context.clearRect(0, 0, this.width, this.height);

    // Rendering
    const render = (node: string): void => {
      const data = this.nodeDataCache[node];

      const { x, y } = this.framedGraphToViewport(data);

      const size = this.scaleSize(data.size);

      this.settings.hoverRenderer(
        context,
        {
          key: node,
          label: data.label,
          color: data.color,
          size,
          x,
          y,
        },
        this.settings,
      );
    };

    const nodesToRender: string[] = [];

    if (this.hoveredNode && !this.nodeDataCache[this.hoveredNode].hidden) {
      nodesToRender.push(this.hoveredNode);
    }

    this.highlightedNodes.forEach((node) => {
      // The hovered node has already been highlighted
      if (node !== this.hoveredNode) nodesToRender.push(node);
    });

    // Draw labels:
    nodesToRender.forEach((node) => render(node));

    // Draw WebGL nodes on top of the labels:
    const nodesPerPrograms: Record<string, number> = {};

    // 1. Count nodes per type:
    nodesToRender.forEach((node) => {
      const type = this.nodeDataCache[node].type;
      nodesPerPrograms[type] = (nodesPerPrograms[type] || 0) + 1;
    });
    // 2. Allocate for each type for the proper number of nodes
    for (const type in this.hoverNodePrograms) {
      this.hoverNodePrograms[type].allocate(nodesPerPrograms[type] || 0);
      // Also reset count, to use when rendering:
      nodesPerPrograms[type] = 0;
    }
    // 3. Process all nodes to render:
    nodesToRender.forEach((node) => {
      const data = this.nodeDataCache[node];
      this.hoverNodePrograms[data.type].process(data, data.hidden, nodesPerPrograms[data.type]++);
    });
    // 4. Render:
    for (const type in this.hoverNodePrograms) {
      const program = this.hoverNodePrograms[type];

      program.bind();
      program.bufferData();
      program.render({
        matrix: this.matrix,
        width: this.width,
        height: this.height,
        ratio: this.camera.ratio,
        nodesPowRatio: 0.5,
        scalingRatio: WEBGL_OVERSAMPLING_RATIO,
      });
    }
  }

  /**
   * Method used to schedule a hover render.
   *
   */
  private scheduleHighlightedNodesRender(): void {
    if (this.renderHighlightedNodesFrame || this.renderFrame) return;

    this.renderHighlightedNodesFrame = requestFrame(() => {
      // Resetting state
      this.renderHighlightedNodesFrame = null;

      // Rendering
      this.renderHighlightedNodes();
      this.renderEdgeLabels();
    });
  }

  /**
   * Method used to render.
   *
   * @return {Sigma}
   */
  private render(): this {
    // If a render was scheduled, we cancel it
    if (this.renderFrame) {
      cancelFrame(this.renderFrame);
      this.renderFrame = null;
      this.needToProcess = false;
      this.needToSoftProcess = false;
    }

    // First we need to resize
    this.resize();

    // Clearing the canvases
    this.clear();

    // Recomputing useful camera-related values:
    this.updateCachedValues();

    // If we have no nodes we can stop right there
    if (!this.graph.order) return this;

    // TODO: improve this heuristic or move to the captor itself?
    // TODO: deal with the touch captor here as well
    const mouseCaptor = this.mouseCaptor;
    const moving =
      this.camera.isAnimated() ||
      mouseCaptor.isMoving ||
      mouseCaptor.draggedEvents ||
      mouseCaptor.currentWheelDirection;

    // Then we need to extract a matrix from the camera
    const cameraState = this.camera.getState();
    const viewportDimensions = this.getDimensions();
    const graphDimensions = this.getGraphDimensions();
    const padding = this.getSetting("stagePadding") || 0;
    this.matrix = matrixFromCamera(cameraState, viewportDimensions, graphDimensions, padding);
    this.invMatrix = matrixFromCamera(cameraState, viewportDimensions, graphDimensions, padding, true);

    // Drawing nodes
    for (const type in this.nodePrograms) {
      const program = this.nodePrograms[type];

      program.bind();
      program.bufferData();
      program.render({
        matrix: this.matrix,
        width: this.width,
        height: this.height,
        ratio: cameraState.ratio,
        nodesPowRatio: 0.5,
        scalingRatio: WEBGL_OVERSAMPLING_RATIO,
      });
    }

    // Drawing edges
    if (!this.settings.hideEdgesOnMove || !moving) {
      for (const type in this.edgePrograms) {
        const program = this.edgePrograms[type];

        program.bind();
        program.bufferData();
        program.render({
          matrix: this.matrix,
          width: this.width,
          height: this.height,
          ratio: cameraState.ratio,
          edgesPowRatio: 0.5,
          scalingRatio: WEBGL_OVERSAMPLING_RATIO,
        });
      }
    }

    // Do not display labels on move per setting
    if (this.settings.hideLabelsOnMove && moving) return this;

    this.renderLabels();
    this.renderEdgeLabels();
    this.renderHighlightedNodes();

    this.emit("afterRender");

    return this;
  }

  /**
   * Internal method used to update expensive and therefore cached values
   * each time the camera state is updated.
   */
  private updateCachedValues(): void {
    const { ratio } = this.camera.getState();
    this.cameraSizeRatio = Math.pow(ratio, SIZE_SCALING_EXPONENT);
  }

  /**---------------------------------------------------------------------------
   * Public API.
   **---------------------------------------------------------------------------
   */

  /**
   * Method returning the renderer's camera.
   *
   * @return {Camera}
   */
  getCamera(): Camera {
    return this.camera;
  }

  /**
   * Method returning the renderer's graph.
   *
   * @return {Graph}
   */
  getGraph(): Graph {
    return this.graph;
  }

  /**
   * Method returning the mouse captor.
   *
   * @return {MouseCaptor}
   */
  getMouseCaptor(): MouseCaptor {
    return this.mouseCaptor;
  }

  /**
   * Method returning the touch captor.
   *
   * @return {TouchCaptor}
   */
  getTouchCaptor(): TouchCaptor {
    return this.touchCaptor;
  }

  /**
   * Method returning the current renderer's dimensions.
   *
   * @return {Dimensions}
   */
  getDimensions(): Dimensions {
    return { width: this.width, height: this.height };
  }

  /**
   * Method returning the current graph's dimensions.
   *
   * @return {Dimensions}
   */
  getGraphDimensions(): Dimensions {
    const extent = this.customBBox || this.nodeExtent;

    return {
      width: extent.x[1] - extent.x[0] || 1,
      height: extent.y[1] - extent.y[0] || 1,
    };
  }

  /**
   * Method used to get all the sigma node attributes.
   * It's usefull for example to get the position of a node
   * and to get values that are set by the nodeReducer
   *
   * @param  {string} key - The node's key.
   * @return {NodeDisplayData | undefined} A copy of the desired node's attribute or undefined if not found
   */
  getNodeDisplayData(key: unknown): NodeDisplayData | undefined {
    const node = this.nodeDataCache[key as string];
    return node ? Object.assign({}, node) : undefined;
  }

  /**
   * Method used to get all the sigma edge attributes.
   * It's usefull for example to get values that are set by the edgeReducer.
   *
   * @param  {string} key - The edge's key.
   * @return {EdgeDisplayData | undefined} A copy of the desired edge's attribute or undefined if not found
   */
  getEdgeDisplayData(key: unknown): EdgeDisplayData | undefined {
    const edge = this.edgeDataCache[key as string];
    return edge ? Object.assign({}, edge) : undefined;
  }

  /**
   * Method returning the current value for a given setting key.
   *
   * @param  {string} key - The setting key to get.
   * @return {any} The value attached to this setting key or undefined if not found
   */
  getSetting<K extends keyof Settings>(key: K): Settings[K] | undefined {
    return this.settings[key];
  }

  /**
   * Method setting the value of a given setting key. Note that this will schedule
   * a new render next frame.
   *
   * @param  {string} key - The setting key to set.
   * @param  {any}    value - The value to set.
   * @return {Sigma}
   */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): this {
    this.settings[key] = value;
    validateSettings(this.settings);
    this.needToProcess = true; // TODO: some keys may work with only needToSoftProcess or even nothing
    this._scheduleRefresh();
    return this;
  }

  /**
   * Method updating the value of a given setting key using the provided function.
   * Note that this will schedule a new render next frame.
   *
   * @param  {string}   key     - The setting key to set.
   * @param  {function} updater - The update function.
   * @return {Sigma}
   */
  updateSetting<K extends keyof Settings>(key: K, updater: (value: Settings[K]) => Settings[K]): this {
    this.settings[key] = updater(this.settings[key]);
    validateSettings(this.settings);
    this.needToProcess = true; // TODO: some keys may work with only needToSoftProcess or even nothing
    this._scheduleRefresh();
    return this;
  }

  /**
   * Method used to resize the renderer.
   *
   * @return {Sigma}
   */
  resize(): this {
    const previousWidth = this.width,
      previousHeight = this.height;

    this.width = this.container.offsetWidth;
    this.height = this.container.offsetHeight;

    if (this.width === 0) throw new Error("Sigma: container has no width.");

    if (this.height === 0) throw new Error("Sigma: container has no height.");

    // If nothing has changed, we can stop right here
    if (previousWidth === this.width && previousHeight === this.height) return this;

    // Sizing dom elements
    for (const id in this.elements) {
      const element = this.elements[id];

      element.style.width = this.width + "px";
      element.style.height = this.height + "px";
    }

    // Sizing canvas contexts
    for (const id in this.canvasContexts) {
      this.elements[id].setAttribute("width", this.width * PIXEL_RATIO + "px");
      this.elements[id].setAttribute("height", this.height * PIXEL_RATIO + "px");

      if (PIXEL_RATIO !== 1) this.canvasContexts[id].scale(PIXEL_RATIO, PIXEL_RATIO);
    }

    // Sizing WebGL contexts
    for (const id in this.webGLContexts) {
      this.elements[id].setAttribute("width", this.width * WEBGL_OVERSAMPLING_RATIO + "px");
      this.elements[id].setAttribute("height", this.height * WEBGL_OVERSAMPLING_RATIO + "px");

      this.webGLContexts[id].viewport(
        0,
        0,
        this.width * WEBGL_OVERSAMPLING_RATIO,
        this.height * WEBGL_OVERSAMPLING_RATIO,
      );
    }

    return this;
  }

  /**
   * Method used to clear all the canvases.
   *
   * @return {Sigma}
   */
  clear(): this {
    this.webGLContexts.nodes.clear(this.webGLContexts.nodes.COLOR_BUFFER_BIT);
    this.webGLContexts.edges.clear(this.webGLContexts.edges.COLOR_BUFFER_BIT);
    this.canvasContexts.labels.clearRect(0, 0, this.width, this.height);
    this.canvasContexts.hovers.clearRect(0, 0, this.width, this.height);
    this.canvasContexts.edgeLabels.clearRect(0, 0, this.width, this.height);

    return this;
  }

  /**
   * Method used to refresh all computed data.
   *
   * @return {Sigma}
   */
  refresh(): this {
    this.needToProcess = true;
    this._refresh();

    return this;
  }

  /**
   * Method used to refresh all computed data, at the next available frame.
   * If this method has already been called this frame, then it will only render once at the next available frame.
   *
   * @return {Sigma}
   */
  scheduleRefresh(): this {
    this.needToProcess = true;
    this._scheduleRefresh();

    return this;
  }

  /**
   * Method used to (un)zoom, while preserving the position of a viewport point.
   * Used for instance to zoom "on the mouse cursor".
   *
   * @param viewportTarget
   * @param newRatio
   * @return {CameraState}
   */
  getViewportZoomedState(viewportTarget: Coordinates, newRatio: number): CameraState {
    const { ratio, angle, x, y } = this.camera.getState();

    // TODO: handle max zoom
    const ratioDiff = newRatio / ratio;

    const center = {
      x: this.width / 2,
      y: this.height / 2,
    };

    const graphMousePosition = this.viewportToFramedGraph(viewportTarget);
    const graphCenterPosition = this.viewportToFramedGraph(center);

    return {
      angle,
      x: (graphMousePosition.x - graphCenterPosition.x) * (1 - ratioDiff) + x,
      y: (graphMousePosition.y - graphCenterPosition.y) * (1 - ratioDiff) + y,
      ratio: newRatio,
    };
  }

  /**
   * Method returning the abstract rectangle containing the graph according
   * to the camera's state.
   *
   * @return {object} - The view's rectangle.
   */
  viewRectangle(): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    height: number;
  } {
    // TODO: reduce relative margin?
    const marginX = (0 * this.width) / 8,
      marginY = (0 * this.height) / 8;

    const p1 = this.viewportToFramedGraph({ x: 0 - marginX, y: 0 - marginY }),
      p2 = this.viewportToFramedGraph({ x: this.width + marginX, y: 0 - marginY }),
      h = this.viewportToFramedGraph({ x: 0, y: this.height + marginY });

    return {
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      height: p2.y - h.y,
    };
  }

  /**
   * Method returning the coordinates of a point from the framed graph system to the viewport system. It allows
   * overriding anything that is used to get the translation matrix, or even the matrix itself.
   *
   * Be careful if overriding dimensions, padding or cameraState, as the computation of the matrix is not the lightest
   * of computations.
   */
  framedGraphToViewport(
    coordinates: Coordinates,
    override: {
      cameraState?: CameraState;
      matrix?: Float32Array;
      viewportDimensions?: Dimensions;
      graphDimensions?: Dimensions;
      padding?: number;
    } = {},
  ): Coordinates {
    const recomputeMatrix = !!override.cameraState || !!override.viewportDimensions || !!override.graphDimensions;
    const matrix = override.matrix
      ? override.matrix
      : recomputeMatrix
      ? matrixFromCamera(
          override.cameraState || this.camera.getState(),
          override.viewportDimensions || this.getDimensions(),
          override.graphDimensions || this.getGraphDimensions(),
          override.padding || this.getSetting("stagePadding") || 0,
        )
      : this.matrix;

    const framedGraphVec = [coordinates.x, coordinates.y, 1];
    const viewportVec = multiplyVec(matrix, framedGraphVec);

    return {
      x: ((1 + viewportVec[0]) * this.width) / 2,
      y: ((1 - viewportVec[1]) * this.height) / 2,
    };
  }

  /**
   * Method returning the coordinates of a point from the viewport system to the framed graph system. It allows
   * overriding anything that is used to get the translation matrix, or even the matrix itself.
   *
   * Be careful if overriding dimensions, padding or cameraState, as the computation of the matrix is not the lightest
   * of computations.
   */
  viewportToFramedGraph(
    coordinates: Coordinates,
    override: {
      cameraState?: CameraState;
      matrix?: Float32Array;
      viewportDimensions?: Dimensions;
      graphDimensions?: Dimensions;
      padding?: number;
    } = {},
  ): Coordinates {
    const recomputeMatrix = !!override.cameraState || !!override.viewportDimensions || !override.graphDimensions;
    const invMatrix = override.matrix
      ? override.matrix
      : recomputeMatrix
      ? matrixFromCamera(
          override.cameraState || this.camera.getState(),
          override.viewportDimensions || this.getDimensions(),
          override.graphDimensions || this.getGraphDimensions(),
          override.padding || this.getSetting("stagePadding") || 0,
          true,
        )
      : this.invMatrix;

    const viewportVec = [(coordinates.x / this.width) * 2 - 1, 1 - (coordinates.y / this.height) * 2, 1];
    const framedGraphVec = multiplyVec(invMatrix, viewportVec);

    return {
      x: framedGraphVec[0],
      y: framedGraphVec[1],
    };
  }

  /**
   * Method used to translate a point's coordinates from the viewport system (pixel distance from the top-left of the
   * stage) to the graph system (the reference system of data as they are in the given graph instance).
   *
   * This method accepts an optional camera which can be useful if you need to translate coordinates
   * based on a different view than the one being currently being displayed on screen.
   *
   * @param {Coordinates} viewportPoint
   */
  viewportToGraph(viewportPoint: Coordinates): Coordinates {
    return this.normalizationFunction.inverse(this.viewportToFramedGraph(viewportPoint));
  }

  /**
   * Method used to translate a point's coordinates from the graph system (the reference system of data as they are in
   * the given graph instance) to the viewport system (pixel distance from the top-left of the stage).
   *
   * This method accepts an optional camera which can be useful if you need to translate coordinates
   * based on a different view than the one being currently being displayed on screen.
   *
   * @param {Coordinates} graphPoint
   */
  graphToViewport(graphPoint: Coordinates): Coordinates {
    return this.framedGraphToViewport(this.normalizationFunction(graphPoint));
  }

  /**
   * Method returning the graph's bounding box.
   *
   * @return {{ x: Extent, y: Extent }}
   */
  getBBox(): { x: Extent; y: Extent } {
    return nodeExtent(this.graph, ["x", "y"]) as { x: Extent; y: Extent };
  }

  /**
   * Method returning the graph's custom bounding box, if any.
   *
   * @return {{ x: Extent, y: Extent } | null}
   */
  getCustomBBox(): { x: Extent; y: Extent } | null {
    return this.customBBox;
  }

  /**
   * Method used to override the graph's bounding box with a custom one. Give `null` as the argument to stop overriding.
   *
   * @return {Sigma}
   */
  setCustomBBox(customBBox: { x: Extent; y: Extent } | null): this {
    this.customBBox = customBBox;
    this._scheduleRefresh();
    return this;
  }

  /**
   * Method used to shut the container & release event listeners.
   *
   * @return {undefined}
   */
  kill(): void {
    const graph = this.graph;

    // Emitting "kill" events so that plugins and such can cleanup
    this.emit("kill");

    // Releasing events
    this.removeAllListeners();

    // Releasing camera handlers
    this.camera.removeListener("updated", this.activeListeners.camera);

    // Releasing DOM events & captors
    window.removeEventListener("resize", this.activeListeners.handleResize);
    this.mouseCaptor.kill();
    this.touchCaptor.kill();

    // Releasing graph handlers
    graph.removeListener("nodeAdded", this.activeListeners.addNodeGraphUpdate);
    graph.removeListener("nodeDropped", this.activeListeners.graphUpdate);
    graph.removeListener("nodeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.removeListener("eachNodeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.removeListener("edgeAdded", this.activeListeners.addEdgeGraphUpdate);
    graph.removeListener("edgeDropped", this.activeListeners.graphUpdate);
    graph.removeListener("edgeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.removeListener("eachEdgeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.removeListener("edgesCleared", this.activeListeners.graphUpdate);
    graph.removeListener("cleared", this.activeListeners.graphUpdate);

    // Releasing cache & state
    this.quadtree = new QuadTree();
    this.nodeDataCache = {};
    this.edgeDataCache = {};

    this.highlightedNodes.clear();

    // Clearing frames
    if (this.renderFrame) {
      cancelFrame(this.renderFrame);
      this.renderFrame = null;
    }

    if (this.renderHighlightedNodesFrame) {
      cancelFrame(this.renderHighlightedNodesFrame);
      this.renderHighlightedNodesFrame = null;
    }

    // Destroying canvases
    const container = this.container;

    while (container.firstChild) container.removeChild(container.firstChild);
  }

  /**
   * Method used to scale the given size according to the camera's ratio, i.e.
   * zooming state.
   *
   * @param  {number} size - The size to scale (node size, edge thickness etc.).
   * @return {number}      - The scaled size.
   */
  scaleSize(size: number): number {
    return size / this.cameraSizeRatio;
  }
}
