import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Location from "expo-location";

const RA_BASE = "https://kart.ra.no/arcgis/rest/services/Distribusjon/Kulturminner/MapServer";
const RA_LAYERS = Array.from({ length: 21 }, (_, i) => i);
const SEARCH_RADIUS = 10000;
const FOUND_RADIUS = 40;
const BOUNDS_DELTA = 0.006;

const toRad = (v) => (v * Math.PI) / 180;
const toDeg = (v) => (v * 180) / Math.PI;
const round5 = (v) => Number(v).toFixed(5);

function makeBounds(lat, lon, delta = BOUNDS_DELTA) {
  return { north: lat + delta, west: lon - delta, south: lat - delta, east: lon + delta };
}

function boundsText(bounds) {
  return `N ${round5(bounds.north)}, V ${round5(bounds.west)}, S ${round5(bounds.south)}, Ø ${round5(bounds.east)}`;
}

function distanceM(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(aLat, aLon, bLat, bLon) {
  const dLon = toRad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function directionText(value) {
  const labels = ["Nord", "Nordøst", "Øst", "Sørøst", "Sør", "Sørvest", "Vest", "Nordvest"];
  return labels[Math.round(value / 45) % labels.length];
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function qs(params) {
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

async function json(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(text);
  if (parsed?.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error).slice(0, 120));
  return parsed;
}

function first(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function averagePoint(points) {
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    const x = n(p?.[0]);
    const y = n(p?.[1]);
    if (x === null || y === null) continue;
    sx += x;
    sy += y;
    count += 1;
  }
  if (!count) return null;
  return { latitude: sy / count, longitude: sx / count };
}

function featurePoint(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  const x = n(g.x);
  const y = n(g.y);
  if (x !== null && y !== null) return { latitude: y, longitude: x };
  const ring = Array.isArray(g.rings) && Array.isArray(g.rings[0]) ? g.rings[0] : null;
  if (ring && ring.length) return averagePoint(ring);
  const path = Array.isArray(g.paths) && Array.isArray(g.paths[0]) ? g.paths[0] : null;
  if (path && path.length) return averagePoint(path);
  return null;
}

function raName(attributes, fallback) {
  return first(attributes, [
    "navn", "NAVN", "lokalitetsnavn", "LOKALITETSNAVN", "enkeltminneart", "ENKELTMINNEART",
    "kulturminneart", "KULTURMINNEART", "art", "ART", "kategori", "KATEGORI", "vernetype", "VERNETYPE"
  ]) || fallback;
}

async function fetchLayerInfo(layerId) {
  try {
    const data = await json(`${RA_BASE}/${layerId}?f=json`);
    return { id: layerId, name: data?.name || `Lag ${layerId}`, geometryType: data?.geometryType || "ukjent" };
  } catch (error) {
    return { id: layerId, name: `Lag ${layerId}`, geometryType: "feil", error: error?.message || String(error) };
  }
}

function normalizeFeature(layerId, feature, index) {
  const point = featurePoint(feature);
  if (!point) return null;
  const attributes = feature.attributes || {};
  return {
    id: `${layerId}-${attributes.OBJECTID || attributes.objectid || index}`,
    layerId,
    layerName: `Lag ${layerId}`,
    source: "Riksantikvaren",
    name: raName(attributes, `Kulturminne ${index + 1}`),
    attributes,
    ...point
  };
}

async function fetchLayerHits(layerId, lat, lon, radius) {
  const url = `${RA_BASE}/${layerId}/query?${qs([
    ["f", "json"], ["where", "1=1"], ["outFields", "*"], ["returnGeometry", "true"],
    ["geometry", `${lon},${lat}`], ["geometryType", "esriGeometryPoint"], ["inSR", 4326], ["outSR", 4326],
    ["spatialRel", "esriSpatialRelIntersects"], ["distance", radius], ["units", "esriSRUnit_Meter"], ["resultRecordCount", 50]
  ])}`;
  const data = await json(url);
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map((feature, index) => normalizeFeature(layerId, feature, index)).filter(Boolean);
}

async function fetchLayerBoundsHits(layerId, bounds) {
  const geometry = `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;
  const url = `${RA_BASE}/${layerId}/query?${qs([
    ["f", "json"], ["where", "1=1"], ["outFields", "*"], ["returnGeometry", "true"],
    ["geometry", geometry], ["geometryType", "esriGeometryEnvelope"], ["inSR", 4326], ["outSR", 4326],
    ["spatialRel", "esriSpatialRelIntersects"], ["resultRecordCount", 100]
  ])}`;
  const data = await json(url);
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map((feature, index) => normalizeFeature(layerId, feature, index)).filter(Boolean);
}

async function scanRiksantikvaren(lat, lon, radius, onProgress) {
  const results = [];
  const layerReports = [];
  for (const layerId of RA_LAYERS) {
    const info = await fetchLayerInfo(layerId);
    try {
      const hits = await fetchLayerHits(layerId, lat, lon, radius);
      const namedHits = hits.map((hit) => ({ ...hit, layerName: info.name || `Lag ${layerId}` }));
      results.push(...namedHits);
      layerReports.push({ ...info, raw: hits.length, error: null });
      onProgress?.(`Lag ${layerId}: ${info.name || "ukjent"} → ${hits.length} treff`);
    } catch (error) {
      layerReports.push({ ...info, raw: 0, error: error?.message || String(error) });
      onProgress?.(`Lag ${layerId}: feil/ingen treff`);
    }
  }
  return { hits: results, layerReports };
}

async function scanRiksantikvarenBounds(bounds, onProgress) {
  const results = [];
  const layerReports = [];
  for (const layerId of RA_LAYERS) {
    const info = await fetchLayerInfo(layerId);
    try {
      const hits = await fetchLayerBoundsHits(layerId, bounds);
      const namedHits = hits.map((hit) => ({ ...hit, layerName: info.name || `Lag ${layerId}` }));
      results.push(...namedHits);
      layerReports.push({ ...info, raw: hits.length, error: null });
      onProgress?.(`Bounds lag ${layerId}: ${info.name || "ukjent"} → ${hits.length} treff`);
    } catch (error) {
      layerReports.push({ ...info, raw: 0, error: error?.message || String(error) });
      onProgress?.(`Bounds lag ${layerId}: feil/ingen treff`);
    }
  }
  return { hits: results, layerReports };
}

function routeFrom(lat, lon, rawPosts, radius, count) {
  const seen = new Set();
  return rawPosts
    .map((post) => ({ ...post, distanceFromStart: distanceM(lat, lon, post.latitude, post.longitude) }))
    .filter((post) => post.distanceFromStart <= radius)
    .filter((post) => {
      const key = `${post.layerId}:${String(post.name).toLowerCase()}:${post.latitude.toFixed(5)}:${post.longitude.toFixed(5)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.distanceFromStart - b.distanceFromStart)
    .slice(0, count)
    .map((post, index) => ({ ...post, number: index + 1, found: false }));
}

function randomPoint(lat, lon, maxRadius) {
  const distance = 8 + Math.random() * Math.max(1, maxRadius - 8);
  const angle = Math.random() * Math.PI * 2;
  const earth = 6371000;
  const latRad = toRad(lat);
  const lonRad = toRad(lon);
  const angular = distance / earth;
  const pointLat = Math.asin(Math.sin(latRad) * Math.cos(angular) + Math.cos(latRad) * Math.sin(angular) * Math.cos(angle));
  const pointLon = lonRad + Math.atan2(Math.sin(angle) * Math.sin(angular) * Math.cos(latRad), Math.cos(angular) - Math.sin(latRad) * Math.sin(pointLat));
  return { latitude: toDeg(pointLat), longitude: toDeg(pointLon) };
}

async function readGpsStatus() {
  const servicesEnabled = await Location.hasServicesEnabledAsync();
  const permission = await Location.getForegroundPermissionsAsync();
  return { servicesEnabled, status: permission.status, granted: permission.granted, canAskAgain: permission.canAskAgain, expires: String(permission.expires) };
}

async function ensureGpsPermission(setGpsStatus) {
  let status = await readGpsStatus();
  setGpsStatus?.(status);
  if (!status.servicesEnabled) {
    Alert.alert("GPS er av", "Slå på posisjonstjenester på telefonen først.");
    return false;
  }
  if (status.status !== "granted") {
    const requested = await Location.requestForegroundPermissionsAsync();
    status = { servicesEnabled: await Location.hasServicesEnabledAsync(), status: requested.status, granted: requested.granted, canAskAgain: requested.canAskAgain, expires: String(requested.expires) };
    setGpsStatus?.(status);
  }
  if (status.status === "granted") return true;
  const message = status.canAskAgain === false ? "Telefonen sier at appen ikke kan spørre på nytt. Åpne innstillinger og gi posisjon til GPS og Gyro Test." : "Testen må ha GPS-tilgang.";
  Alert.alert("GPS ikke godkjent", message);
  return false;
}

async function getGpsFix(setGpsStatus) {
  const allowed = await ensureGpsPermission(setGpsStatus);
  if (!allowed) return null;
  return await new Promise((resolve) => {
    let settled = false;
    let sub = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (sub) sub.remove();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 12000);
    Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 }, (next) => {
      clearTimeout(timeout);
      finish(next);
    }).then((subscription) => { sub = subscription; }).catch((error) => {
      clearTimeout(timeout);
      console.log("GPS first fix feilet:", error?.message || error);
      Alert.alert("GPS feilet", "Telefonen nekter fortsatt GPS. Trykk Sjekk GPS-status og se hva status viser.");
      finish(null);
    });
  });
}

export default function App() {
  const [screen, setScreen] = useState("MENU");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Klar.");
  const [apiStatus, setApiStatus] = useState("");
  const [gpsStatus, setGpsStatus] = useState(null);
  const [location, setLocation] = useState(null);
  const [posts, setPosts] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [layerReports, setLayerReports] = useState([]);
  const [pendingFallback, setPendingFallback] = useState(false);

  useEffect(() => { readGpsStatus().then(setGpsStatus).catch(() => {}); }, []);

  useEffect(() => {
    if (screen !== "REBUS") return undefined;
    let gpsSub;
    let mounted = true;
    async function watch() {
      try {
        const allowed = await ensureGpsPermission(setGpsStatus);
        if (!allowed || !mounted) return;
        gpsSub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 1 }, (next) => mounted && setLocation(next));
      } catch (error) {
        console.log("GPS-sporing feilet:", error?.message || error);
        if (mounted) setStatus("GPS-sporing feilet. Sjekk GPS-status.");
      }
    }
    watch();
    return () => { mounted = false; if (gpsSub) gpsSub.remove(); };
  }, [screen]);

  const activePost = posts[activeIndex] || null;
  const activeDistance = useMemo(() => !location || !activePost ? null : distanceM(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude), [location, activePost]);
  const activeBearing = useMemo(() => !location || !activePost ? null : bearing(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude), [location, activePost]);

  useEffect(() => {
    if (screen !== "REBUS" || !location || !activePost || activePost.found) return;
    const d = distanceM(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude);
    if (d <= FOUND_RADIUS) {
      const updated = posts.map((post, index) => index === activeIndex ? { ...post, found: true } : post);
      setPosts(updated);
      const nextIndex = updated.findIndex((post) => !post.found);
      if (nextIndex === -1) setStatus("Post funnet. Alle postene er funnet.");
      else { setActiveIndex(nextIndex); setStatus(`Post ${activePost.number} funnet. Gå til post ${updated[nextIndex].number}: ${updated[nextIndex].name}`); }
      return;
    }
    setStatus(`Gå mot ${directionText(bearing(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude))}. Avstand: ${Math.round(d)} meter.`);
  }, [location, screen, activeIndex, activePost, posts]);

  async function refreshGps() {
    try { setGpsStatus(await readGpsStatus()); } catch (error) { setStatus(`Klarte ikke lese GPS-status: ${error?.message || error}`); }
  }

  function openSettings() { Linking.openSettings().catch(() => Alert.alert("Innstillinger", "Klarte ikke åpne app-innstillinger.")); }

  function startWithRoute(route) {
    setPendingFallback(false);
    setPosts(route);
    setActiveIndex(0);
    setScreen("REBUS");
    setStatus(route.length === 1 ? `1-post test klar. Gå til: ${route[0].name}` : `Rebus klar. Gå til post 1: ${route[0].name}`);
  }

  function startGpsFallbackPost() {
    if (!location) { Alert.alert("Ingen GPS", "Start Riksantikvaren-test først, så appen har et startpunkt."); return; }
    const point = randomPoint(location.coords.latitude, location.coords.longitude, 35);
    const fallback = [{ id: "gps-fallback-1", number: 1, found: false, source: "GPS-test", layerName: "Lokal testpost", layerId: "test", name: "Testpost nær deg", ...point, distanceFromStart: distanceM(location.coords.latitude, location.coords.longitude, point.latitude, point.longitude) }];
    startWithRoute(fallback);
  }

  async function startRaTest() {
    setLoading(true); setScreen("RA_TEST"); setPosts([]); setLayerReports([]); setPendingFallback(false); setStatus("Henter GPS..."); setApiStatus("Starter Riksantikvaren layer-scan.");
    try {
      const current = await getGpsFix(setGpsStatus);
      if (!current) { setStatus("Ingen GPS-fix. Trykk Sjekk GPS-status og kontroller tillatelsen."); return; }
      setLocation(current);
      const lat = current.coords.latitude;
      const lon = current.coords.longitude;
      const accuracy = current.coords.accuracy ? `${Math.round(current.coords.accuracy)} m` : "ukjent";
      setApiStatus(`GPS ${round5(lat)}, ${round5(lon)}. Nøyaktighet: ${accuracy}. Søker ${SEARCH_RADIUS} m.`);
      const result = await scanRiksantikvaren(lat, lon, SEARCH_RADIUS, setStatus);
      setLayerReports(result.layerReports);
      const route = routeFrom(lat, lon, result.hits, SEARCH_RADIUS, 2);
      const useful = routeFrom(lat, lon, result.hits, SEARCH_RADIUS, 99);
      const layersWithHits = result.layerReports.filter((layer) => layer.raw > 0);
      setApiStatus(`RA lag sjekket: ${result.layerReports.length}. Lag med treff: ${layersWithHits.length}. Rå treff: ${result.hits.length}. Brukbare: ${useful.length}.`);
      if (route.length > 0) { startWithRoute(route); return; }
      setPendingFallback(true); setStatus("Ingen Riksantikvaren-treff fra lag 0–20 her. Se lagrapport under.");
    } catch (error) {
      console.log("RA-test feilet:", error?.message || error); setStatus(`Riksantikvaren-test feilet: ${error?.message || error}`); Alert.alert("Riksantikvaren feilet", "Se statusfeltet for detaljer.");
    } finally { setLoading(false); }
  }

  async function startGpsBoundsTest() {
    setLoading(true); setScreen("RA_TEST"); setPosts([]); setLayerReports([]); setPendingFallback(false); setStatus("Henter GPS og lager Kulturminnesøk-bounds..."); setApiStatus("Starter bounds-test rundt GPS.");
    try {
      const current = await getGpsFix(setGpsStatus);
      if (!current) { setStatus("Ingen GPS-fix. Trykk Sjekk GPS-status og kontroller tillatelsen."); return; }
      setLocation(current);
      const lat = current.coords.latitude;
      const lon = current.coords.longitude;
      const bounds = makeBounds(lat, lon);
      const accuracy = current.coords.accuracy ? `${Math.round(current.coords.accuracy)} m` : "ukjent";
      setApiStatus(`GPS ${round5(lat)}, ${round5(lon)}. Nøyaktighet: ${accuracy}. Bounds: ${boundsText(bounds)}.`);
      const result = await scanRiksantikvarenBounds(bounds, setStatus);
      setLayerReports(result.layerReports);
      const route = routeFrom(lat, lon, result.hits, SEARCH_RADIUS, 2);
      const useful = routeFrom(lat, lon, result.hits, SEARCH_RADIUS, 99);
      const layersWithHits = result.layerReports.filter((layer) => layer.raw > 0);
      setApiStatus(`Bounds-test. Lag sjekket: ${result.layerReports.length}. Lag med treff: ${layersWithHits.length}. Rå treff: ${result.hits.length}. Brukbare: ${useful.length}.`);
      if (route.length > 0) { startWithRoute(route); return; }
      setPendingFallback(true); setStatus("Ingen treff i GPS-bounds-testen. Se lagrapport under.");
    } catch (error) {
      console.log("Bounds-test feilet:", error?.message || error); setStatus(`Bounds-test feilet: ${error?.message || error}`); Alert.alert("Bounds-test feilet", "Se statusfeltet for detaljer.");
    } finally { setLoading(false); }
  }

  function reset() { setScreen("MENU"); setLoading(false); setStatus("Klar."); setApiStatus(""); setPosts([]); setActiveIndex(0); setLayerReports([]); setPendingFallback(false); }

  const foundCount = posts.filter((post) => post.found).length;

  if (screen === "MENU") {
    return (
      <View style={styles.menu}>
        <Text style={styles.title}>Riksantikvaren GPS-test</Text>
        <Text style={styles.menuText}>Tester Riksantikvaren kartlag. Kartverket, Sonar og gyro er fjernet fra testflyten.</Text>
        {loading ? <ActivityIndicator size="large" color="#FFFFFF" /> : null}
        <GpsStatusBox gpsStatus={gpsStatus} onRefresh={refreshGps} onSettings={openSettings} />
        <TouchableOpacity style={styles.mainButton} onPress={startRaTest} disabled={loading}>
          <Text style={styles.buttonTitle}>START GPS RIKSANTIKVAREN-TEST</Text>
          <Text style={styles.buttonText}>GPS • RA MapServer lag 0–20 • 10 km radius</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.mainButton, styles.localButton]} onPress={startGpsBoundsTest} disabled={loading}>
          <Text style={styles.buttonTitle}>TEST KULTURMINNESØK-BOUNDS</Text>
          <Text style={styles.buttonText}>Lager kartutsnitt rundt GPS • uten private coords i repo</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.game}>
      <Text style={styles.title}>{screen === "REBUS" ? "Rebus API-test" : "Riksantikvaren-test"}</Text>
      <Text style={styles.kicker}>Riksantikvaren</Text>
      <View style={styles.card}>
        {loading ? <ActivityIndicator size="large" color="#F59E0B" /> : null}
        <Text style={styles.status}>{status}</Text>
        <GpsStatusBox gpsStatus={gpsStatus} onRefresh={refreshGps} onSettings={openSettings} compact />
        <Text style={styles.meta}>{apiStatus}</Text>
        {screen === "REBUS" ? (
          <>
            <Text style={styles.meta}>Poster funnet: {foundCount} / {posts.length}</Text>
            {activePost && !activePost.found ? (
              <View style={styles.postCard}>
                <Text style={styles.source}>{activePost.source} • {activePost.layerName}</Text>
                <Text style={styles.postName}>{activePost.name}</Text>
                <Text style={styles.postMeta}>Avstand: {activeDistance === null ? "venter på GPS" : `${Math.round(activeDistance)} m`}</Text>
                <Text style={styles.postMeta}>Retning: {activeBearing === null ? "venter på GPS" : directionText(activeBearing)}</Text>
                <Text style={styles.postMeta}>GPS-nøyaktighet: {location?.coords?.accuracy !== undefined ? `${Math.round(location.coords.accuracy)} m` : "ukjent"}</Text>
              </View>
            ) : null}
          </>
        ) : (
          <>
            {pendingFallback ? (
              <View style={styles.choiceCard}>
                <Text style={styles.choiceTitle}>Ingen RA-treff</Text>
                <Text style={styles.choiceText}>GPS fungerer, men RA-lagene ga ikke treff. Du kan lage en lokal testpost for å teste GPS-godkjenning.</Text>
                <TouchableOpacity style={styles.choiceButton} onPress={startGpsFallbackPost} disabled={loading}><Text style={styles.choiceButtonText}>Lag GPS-testpost her</Text></TouchableOpacity>
              </View>
            ) : null}
            <LayerReport reports={layerReports} />
          </>
        )}
      </View>
      <TouchableOpacity style={styles.backButton} onPress={reset}><Text style={styles.backText}>Tilbake</Text></TouchableOpacity>
    </ScrollView>
  );
}

function GpsStatusBox({ gpsStatus, onRefresh, onSettings, compact }) {
  return (
    <View style={styles.gpsBox}>
      <Text style={styles.gpsTitle}>GPS-status</Text>
      <Text style={styles.gpsText}>Stedstjenester: {gpsStatus ? String(gpsStatus.servicesEnabled) : "ukjent"}</Text>
      <Text style={styles.gpsText}>Permission: {gpsStatus?.status || "ukjent"}</Text>
      <Text style={styles.gpsText}>Granted: {gpsStatus ? String(gpsStatus.granted) : "ukjent"}</Text>
      {!compact ? <Text style={styles.gpsText}>Can ask again: {gpsStatus ? String(gpsStatus.canAskAgain) : "ukjent"}</Text> : null}
      <View style={styles.gpsButtons}>
        <TouchableOpacity style={styles.smallButton} onPress={onRefresh}><Text style={styles.smallButtonText}>Sjekk GPS-status</Text></TouchableOpacity>
        <TouchableOpacity style={styles.smallButton} onPress={onSettings}><Text style={styles.smallButtonText}>Åpne innstillinger</Text></TouchableOpacity>
      </View>
    </View>
  );
}

function LayerReport({ reports }) {
  if (!reports.length) return null;
  return (
    <View style={styles.layerBox}>
      <Text style={styles.layerTitle}>Lagrapport</Text>
      {reports.map((layer) => (
        <View key={layer.id} style={[styles.layerRow, layer.raw > 0 && styles.layerHit]}>
          <Text style={styles.layerText}>Lag {layer.id}: {layer.name}</Text>
          <Text style={styles.layerSub}>Treff: {layer.raw} • Type: {layer.geometryType}</Text>
          {layer.error ? <Text style={styles.layerError}>{String(layer.error).slice(0, 90)}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { flex: 1, backgroundColor: "#0F172A", justifyContent: "center", alignItems: "center", padding: 24 },
  game: { flexGrow: 1, backgroundColor: "#1E3A8A", padding: 20, justifyContent: "center", alignItems: "center" },
  title: { color: "#FFFFFF", fontSize: 30, fontWeight: "900", textAlign: "center", marginBottom: 8 },
  kicker: { color: "#F59E0B", fontSize: 13, fontWeight: "900", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 16 },
  menuText: { color: "#94A3B8", fontSize: 16, lineHeight: 23, textAlign: "center", marginBottom: 18 },
  mainButton: { width: "100%", backgroundColor: "#3B82F6", borderRadius: 18, padding: 24, alignItems: "center", marginTop: 18 },
  localButton: { backgroundColor: "#10B981" },
  buttonTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "900", textAlign: "center" },
  buttonText: { color: "rgba(255,255,255,0.82)", marginTop: 6, textAlign: "center" },
  card: { width: "100%", backgroundColor: "#1E293B", borderRadius: 20, padding: 20, alignItems: "center", borderWidth: 1, borderColor: "rgba(148, 163, 184, 0.14)" },
  status: { color: "#E2E8F0", fontSize: 20, fontWeight: "800", lineHeight: 28, textAlign: "center", marginTop: 8, marginBottom: 10 },
  meta: { color: "#94A3B8", fontSize: 14, marginTop: 8, textAlign: "center" },
  gpsBox: { width: "100%", backgroundColor: "#111827", borderRadius: 16, padding: 14, marginTop: 10, borderWidth: 1, borderColor: "#334155" },
  gpsTitle: { color: "#F59E0B", fontSize: 15, fontWeight: "900", marginBottom: 6, textAlign: "center" },
  gpsText: { color: "#E2E8F0", fontSize: 13, lineHeight: 19, textAlign: "center" },
  gpsButtons: { flexDirection: "row", gap: 8, marginTop: 10 },
  smallButton: { flex: 1, minHeight: 42, backgroundColor: "#334155", borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  smallButtonText: { color: "#E2E8F0", fontSize: 12, fontWeight: "900", textAlign: "center" },
  choiceCard: { width: "100%", backgroundColor: "#EEF2FF", borderRadius: 16, padding: 16, marginTop: 18 },
  choiceTitle: { color: "#1E3A8A", fontSize: 18, fontWeight: "900", textAlign: "center" },
  choiceText: { color: "#334155", fontSize: 15, lineHeight: 21, textAlign: "center", marginTop: 6, marginBottom: 8 },
  choiceButton: { minHeight: 48, borderRadius: 14, backgroundColor: "#2563EB", alignItems: "center", justifyContent: "center", marginTop: 10 },
  choiceButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "900", textAlign: "center" },
  postCard: { width: "100%", backgroundColor: "#F8FAFC", borderColor: "#E2E8F0", borderWidth: 1, borderRadius: 16, padding: 16, marginTop: 18 },
  source: { color: "#2563EB", fontSize: 13, fontWeight: "900", textTransform: "uppercase", marginBottom: 5 },
  postName: { color: "#0F172A", fontSize: 19, lineHeight: 25, fontWeight: "900", marginBottom: 10 },
  postMeta: { color: "#334155", fontSize: 15, lineHeight: 22, fontWeight: "600" },
  layerBox: { width: "100%", marginTop: 18 },
  layerTitle: { color: "#F59E0B", fontSize: 17, fontWeight: "900", textAlign: "center", marginBottom: 10 },
  layerRow: { width: "100%", backgroundColor: "#111827", borderRadius: 12, padding: 12, marginTop: 8, borderWidth: 1, borderColor: "#334155" },
  layerHit: { borderColor: "#22C55E", backgroundColor: "rgba(34,197,94,0.12)" },
  layerText: { color: "#E2E8F0", fontSize: 14, fontWeight: "800" },
  layerSub: { color: "#94A3B8", fontSize: 13, marginTop: 3 },
  layerError: { color: "#FCA5A5", fontSize: 12, marginTop: 3 },
  backButton: { marginTop: 40, borderBottomColor: "#CBD5E1", borderBottomWidth: 1, paddingBottom: 5 },
  backText: { color: "#CBD5E1", fontSize: 16, fontWeight: "700" }
});
