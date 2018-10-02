function zoom_transition_plot(svg, fast_zoom = true) {
  const DESCRIPTOR_FILE = "data/descriptor.json";

  // Standard D3 plot setup with margins for the axes.
  const margin = { top: 20, right: 20, bottom: 20, left: 30 };
  const width = +svg.attr("width") - margin.left - margin.right;
  const height = +svg.attr("height") - margin.top - margin.bottom;
  const g = svg
    .append("g")
    .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

  const Y_DOMAIN = [-128, 127];
  const yScale = d3
    .scaleLinear()
    .domain(Y_DOMAIN)
    .range([height, 0]);

  const X_FULL_DOMAIN = [0, 1];
  const xDataScale = d3
    .scaleLinear()
    .domain(X_FULL_DOMAIN)
    .range([0, width])
    .clamp(true);

  const xAxis = d3.axisBottom(xDataScale).ticks(10);
  const yAxis = d3.axisLeft(yScale).ticks(4);

  // Area chart function
  const area = d3
    .area()
    .y0(d => yScale(d.min))
    .y1(d => yScale(d.max));

  // Line chart function
  const line = d3.line().y(d => yScale(d));

  // Create a brush for selecting regions to zoom on.
  const brush = d3
    .brushX()
    .extent([[0, 1], [width, height - 1]])
    .on("end", brushEnded);

  const ZOOM_TIME = fast_zoom ? 500 : 5000;
  const CROSS_FADE_TIME = 150;
  const TRANSITION_EASE = d3.easeSin;
  const MIN_ZOOM_ELEMENTS = 5;

  let idleTimeout;
  const IDLE_DELAY = 350;

  let dataDescriptor;

  // Track the top level and current data sets
  let topData;
  let currentData;

  // Keep track of our current zooming status.
  let zoomTargetDomain;
  let zoomInProgress;
  const startZoom = () => {
    zoomInProgress = true;
  };
  const endZoom = () => {
    zoomInProgress = false;
  };

  // A clip path is needed to mask the chart under flowing the axes while zooming.
  svg
    .append("defs")
    .append("svg:clipPath")
    .attr("id", "clip")
    .append("svg:rect")
    .attr("width", width)
    .attr("height", height)
    .attr("x", 0)
    .attr("y", 0);

  // X-axis
  g.append("g")
    .attr("class", "x-axis")
    .attr("transform", "translate(0," + height + ")")
    .call(xAxis);

  // Y-axis
  g.append("g")
    .attr("class", "y-axis")
    .call(yAxis);

  // Data view
  const gDataView = g.append("g").attr("class", "data-view");

  // Zoom brush
  g.append("g")
    .attr("class", "brush")
    .call(brush);

  main();

  // Setup and draw the initial view
  async function main() {
    // First download the descriptor file for our data.
    await fetchDescriptor();

    // Then fetch the data that we want to plot.
    currentData = await fetchData(X_FULL_DOMAIN);
    topData = currentData;

    // Then plot it
    const xViewScale = d3
      .scaleLinear()
      .domain([0, currentData.elements.length - 1])
      .range([0, width]);

    gDataView
      .insert("path")
      .attr("class", getClass(currentData))
      .attr("d", drawPath(currentData, xViewScale));
  }

  // Draw a path, either an area or a line chart, depending on the level
  function drawPath(data, scale) {
    const pathFunc = data.level > 0 ? area : line;
    return pathFunc.x((d, i) => scale(i))(data.elements);
  }

  // Choose the CSS class for an area or line chart, depending on the level.
  function getClass(data) {
    return data.level > 0 ? "dataView area" : "dataView line";
  }

  // Handler for the end of a brush event from D3.
  function brushEnded() {
    const s = d3.event.selection;

    // Consume the brush action
    if (s) {
      svg.select(".brush").call(brush.move, null);
    }

    // Lock out interactions while a zoom is in progress.
    if (zoomInProgress) {
      return;
    }

    if (s) {
      zoomIn(s);
    } else {
      // Rudimentary double-click detection
      if (!idleTimeout) {
        return (idleTimeout = setTimeout(() => {
          idleTimeout = null;
        }, IDLE_DELAY));
      }

      zoomOut();
    }
  }

  async function zoomIn(s) {
    // Convert the span from screen coordinates to data space values.
    const newDomain = s.map(xDataScale.invert, xDataScale);

    // Check to see if we're trying to go lower than our minimum.
    if (
      newDomain[1] - newDomain[0] <
      MIN_ZOOM_ELEMENTS / dataDescriptor.nElements
    ) {
      console.log("Max Zoom");
      return;
    }

    zoomTargetDomain = newDomain;

    // Adjust the X scale
    xDataScale.domain(newDomain);

    // Setup a transition for the axis
    const zoomTransition = svg
      .transition("zoomTransition")
      .ease(TRANSITION_EASE)
      .duration(ZOOM_TIME)
      .on("start", startZoom)
      .on("end", endZoom);

    // Render the axis on the new domain with the transition.
    svg
      .select(".x-axis")
      .transition(zoomTransition)
      .call(xAxis);

    const lowResView = gDataView.selectAll(".dataView");
    if (currentData != null) {
      // Work out the new scale for the old data set and start the transition to it.
      const v = rangeFraction(currentData.domain, newDomain);
      const N = currentData.elements.length - 1;
      const newViewDomain = [v[0] * N, v[1] * N];
      const xNewViewScale = d3
        .scaleLinear()
        .domain(newViewDomain)
        .range([0, width]);

      lowResView
        .transition(zoomTransition)
        .attr("d", drawPath(currentData, xNewViewScale));

      // If the zoom is within the same level, then we're done.
      if (currentData.level === levelFromDomain(newDomain)) {
        return;
      }
    }

    // If the zoom was not within the same level, then we're off to grab
    // some higher resolution data.
    const zoomTimeStarted = Date.now();

    let newData;
    try {
      newData = await fetchData(newDomain);

      // ... and we're back! Time to check in on the state of the world.

      // First, check that this data we've gotten back is still what we want.
      // If the network was slow getting this chunk back to us, the user might
      // have already zoomed to some other view.
      if (newDomain !== zoomTargetDomain) {
        return;
      }
    } catch (ex) {
      // If we can't get the data we want, then stick with what we've got.
      console.warn(ex);
      return;
    }

    // At this point we can be in one of two places:
    //
    // 1. The zoom transition could still be going with a long time left.
    //    In this case, we'll synchronize the cross fade transition with the
    //    zoom so they finish at the same time.
    //
    // 2. The zoom transition may be almost done, or already finished.
    //    We still want a cross fade transition, but we'll schedule it on its
    //    own timeline.

    // Find out how long we've been waiting for data.
    const timeElapsed = Date.now() - zoomTimeStarted;
    const zoomTimeRemaining = ZOOM_TIME - timeElapsed;

    const fadeTime = Math.max(CROSS_FADE_TIME, zoomTimeRemaining);

    const fadeTransition = svg
      .transition("fadeTransition")
      .ease(TRANSITION_EASE)
      .duration(fadeTime);

    const xEndDomain = [0, newData.elements.length - 1];
    const xStartViewScale = d3
      .scaleLinear()
      .domain(xEndDomain)
      .range(s);
    const xEndViewScale = d3
      .scaleLinear()
      .domain(xEndDomain)
      .range([0, width]);

    const highResView = gDataView
      .insert("path", ":first-child")
      .attr("class", getClass(newData))
      .attr("opacity", "0");

    // If we're still zooming in, then animate the path coming in. 
    // Otherwise, we'll fade in directly at the end position.
    if (zoomTimeRemaining > CROSS_FADE_TIME) {
      highResView
        .attr("d", drawPath(newData, xStartViewScale))
        .transition(zoomTransition)
        .attr("d", drawPath(newData, xEndViewScale))
        .attr("opacity", "1");
    } else {
      highResView
        .attr("d", drawPath(newData, xEndViewScale))
        .transition(fadeTransition)
        .attr("opacity", "1");
    }

    // Fade opacity from 1..0 then remove the plot.
    lowResView
      .attr("opacity", "1")
      .transition(fadeTransition)
      .attr("opacity", "0")
      .remove();

    currentData = newData;
  }

  function zoomOut() {
    const oldDomain = xDataScale.domain();

    // Don't zoom out if we're already zoomed out.
    if (
      oldDomain[0] === X_FULL_DOMAIN[0] &&
      oldDomain[1] === X_FULL_DOMAIN[1]
    ) {
      return;
    }

    zoomTargetDomain = X_FULL_DOMAIN;

    // Adjust the X scale
    xDataScale.domain(X_FULL_DOMAIN);

    // Setup the transition
    const zoomTransition = svg
      .transition("zoomTransition")
      .ease(d3.easeSinInOut)
      .duration(ZOOM_TIME)
      .on("start", startZoom)
      .on("end", endZoom);

    // Transition the axis
    svg
      .select(".x-axis")
      .transition(zoomTransition)
      .call(xAxis);

    if (currentData) {

      // Zoom out to the top level
      const oldRange = [oldDomain[0] * width, oldDomain[1] * width];
      const oldViewScale = d3
        .scaleLinear()
        .domain([0, currentData.elements.length - 1])
        .range(oldRange);

      gDataView
        .selectAll(".dataView")
        .attr("opacity", 1)
        .transition(zoomTransition)
        .attr("d", drawPath(currentData, oldViewScale))
        .attr("opacity", 0.4)
        .remove();
    }

    // Zoom back in the top level data
    const N = topData.elements.length - 1;
    const xStartDomain = [N * oldDomain[0], N * oldDomain[1]];
    const xEndDomain = [0, N];
    const xStartViewScale = d3
      .scaleLinear()
      .domain(xStartDomain)
      .range([0, width]);
    const xEndViewScale = d3
      .scaleLinear()
      .domain(xEndDomain)
      .range([0, width]);

    gDataView
      .insert("path", ":first-child")
      .attr("class", getClass(topData))
      .attr("opacity", -1)
      .attr("d", drawPath(topData, xStartViewScale))
      .transition(zoomTransition)
      .attr("d", drawPath(topData, xEndViewScale))
      .attr("opacity", 1);

    currentData = topData;
  }

  // Find the fractional range of b inside a.
  function rangeFraction(a, b) {
    const span = 1 / (a[1] - a[0]);
    return [(b[0] - a[0]) * span, 1 - (a[1] - b[1]) * span];
  }

  // Fetch data to be plotted.
  async function fetchData(domain) {
    const level = levelFromDomain(domain);

    let nElements;
    if (level === 0) {
      nElements = dataDescriptor.nElements;
    } else {
      nElements = dataDescriptor.lodFiles[level - 1].nElements;
    }

    // Convert from the domain space 0..1 to actual elements in this scale level
    const elementStart = Math.max(Math.floor(domain[0] * nElements), 0);
    const elementEnd = Math.min(
      Math.ceil(domain[1] * nElements),
      nElements - 1
    );

    if (level > 0) {
      const lodFile = dataDescriptor.lodFiles[level - 1];

      // Determine byte offsets for these elements:
      // Each element is 2 bytes (min, max)
      const ELEMENT_SIZE = 2;

      const rangeStart = elementStart * ELEMENT_SIZE;
      const rangeEnd = elementEnd * ELEMENT_SIZE + ELEMENT_SIZE - 1;

      const view = await fetchByteRange(lodFile.fileName, rangeStart, rangeEnd);
      let elements = [];
      for (let i = 0; i < view.byteLength - 1; i += 2) {
        elements.push({
          min: view[i],
          max: view[i + 1]
        });
      }

      return { domain, level, elements };
    } else {
      // At level 0 we have actual data points (not min/max aggregates)
      const elements = await fetchByteRange(
        dataDescriptor.fileName,
        elementStart,
        elementEnd
      );
      return { domain, level, elements };
    }
  }

  // Determine which level to use for a view, given a domain span.
  function levelFromDomain(domain) {
    const domainSpan = domain[1] - domain[0];

    // Check level 0
    const nElements = Math.ceil(dataDescriptor.nElements * domainSpan);
    if (nElements <= dataDescriptor.maxElements) return 0;

    // Then check the LOD levels.
    let a = Math.log(nElements / dataDescriptor.maxElements);
    let b = Math.log(dataDescriptor.windowSize);
    return Math.ceil(a / b);
  }

  // Fetch a byte range for a file.
  async function fetchByteRange(file, rangeStart, rangeEnd) {
    const headers = { Range: `bytes=${rangeStart}-${rangeEnd}` };
    const response = await fetch(file, { headers });

    const buf = await response.arrayBuffer();
    let byteOffset = 0;
    let length = rangeEnd - rangeStart + 1;

    // If the server sends back the whole file for some reason,
    // then we'll handle it by doing our own offset into it.
    if (response.status === 200) {
      byteOffset = rangeStart;
    }

    const view = await new Int8Array(buf, byteOffset, length);
    return view;
  }

  // Fetch the descriptor file
  async function fetchDescriptor() {
    const response = await fetch(DESCRIPTOR_FILE);
    dataDescriptor = await response.json();
  }
}
