import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Location from "expo-location";

const OGC_BASE = "https://api.ra.no/LokaliteterEnkeltminnerOgSikringssoner";
const OGC_COLLECTIONS = [
  { id: "lokaliteter", label: "Lokaliteter", priority: 1 },
  { id: "enkeltminner", label: "Enkeltminner", priority: 2 },
  { id: "sikringssoner", label: "Sikringssoner", priority: 9 }
];
const BOUNDS_DELTA = 0.018;
const FOUND_RADIUS = 40;
const ROUTE_COUNT = 2;

const toRad = (v) => (v * Math.PI) / 180;
const toDeg = (v) => (v * 180) / Math.PI;
const round5 = (v) => Number(v).toFixed(5);

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

function qs(params) {
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

function makeBounds(lat, lon, delta = BOUNDS_DELTA) {
  return { west: lon - delta, south: lat - delta, east: lon + delta, north: lat + delta };
}

function boundsToBbox(bounds) {
  return `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;
}

function boundsText(bounds) {
  return `V ${round5(bounds.west)}, S ${round5(bounds.south)}, Ø ${round5(bounds.east)}, N ${round5(bounds.north)}`;
}

async function json(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 140)}`);
  return JSON.parse(text);
}

function first(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function averageLonLat(points) {
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    sx += lon;
    sy += lat;
    count += 1;
  }
  if (!count) return null;
  return { longitude: sx / count, latitude: sy / count };
}

function collectCoordinates(geometry) {
  const out = [];
  function walk(value) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      out.push(value);
      return;
    }
    value.forEach(walk);
  }
  walk(geometry?.coordinates);
  return out;
}

function featurePoint(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    return { longitude: Number(geometry.coordinates[0]), latitude: Number(geometry.coordinates[1]) };
  }
  return averageLonLat(collectCoordinates(geometry));
}

function featureName(properties, fallback) {
  return first(properties, [
    "navn", "lokalitetsnavn", "enkeltminneart", "art", "kategori", "vernetype",
    "NAVN", "LOKALITETSNAVN", "ENKELTMINNEART", "ART", "KATEGORI", "VERNETYPE"
  ]) || fallback;
}

function normalizeFeature(collection, feature, index) {
  const point = featurePoint(feature);
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
  const properties = feature.properties || {};
  return {
    id: `${collection.id}-${feature.id || properties.id || properties.OBJECTID || index}`,
    collectionId: collection.id,
    collectionLabel: collection.label,
    priority: collection.priority,
    source: "Riksantikvaren OGC",
    name: featureName(properties, `${collection.label} ${index + 1}`),
    properties,
    latitude: point.latitude,
    longitude: point.longitude
  };
}

async function fetchOgcCollection(collection, bounds, limit = 100) {
  const url = `${OGC_BASE}/collections/${collection.id}/items?${qs([
    ["f", "json"],
    ["bbox", boundsToBbox(bounds)],
    ["limit", limit]
  ])}`;
  const data = await json(url);
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map((feature, index) => normalizeFeature(collection, feature, index)).filter(Boolean);
}

async function scanOgcBounds(bounds, onProgress) {
  const results = [];
  const reports = [];
  for (const collection of OGC_COLLECTIONS) {
    try {
      const hits = await fetchOgcCollection(collection, bounds, 100);
      results.push(...hits);
      reports.push({ id: collection.id, name: collection.label, raw: hits.length, error: null });
      onProgress?.(`${collection.label}: ${hits.length} treff`);
    } catch (error) {
      reports.push({ id: collection.id, name: collection.label, raw: 0, error: error?.message || String(error) });
      onProgress?.(`${collection.label}: feil`);
    }
  }
  return { hits: results, reports };
}

function routeFrom(lat, lon, rawPosts, count) {
  const seen = new Set();
  const sorted = rawPosts
    .map((post) => ({ ...post, distanceFromStart: distanceM(lat, lon, post.latitude, post.longitude) }))
    .filter((post) => Number.isFinite(post.distanceFromStart))
    .filter((post) => {
      const key = `${post.collectionId}:${String(post.name).toLowerCase()}:${post.latitude.toFixed(5)}:${post.longitude.toFixed(5)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.priority - b.priority) || (a.distanceFromStart - b.distanceFromStart));
  const preferred = sorted.filter((post) => post.collectionId !== "sikringssoner");
  return (preferred.length ? preferred : sorted)
    .slice(0, count)
    .map((post, index) => ({ ...post, number: index + 1, found: false }));
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
  const [reports, setReports] = useState([]);

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
    setPosts(route);
    setActiveIndex(0);
    setScreen("REBUS");
    setStatus(route.length === 1 ? `1-post test klar. Gå til: ${route[0].name}` : `Rebus klar. Gå til post 1: ${route[0].name}`);
  }

  async function startOgcTest() {
    setLoading(true);
    setScreen("OGC_TEST");
    setPosts([]);
    setReports([]);
    setStatus("Henter GPS og lager større OGC-bounds...");
    setApiStatus("Starter Riksantikvaren OGC GeoJSON-test.");
    try {
      const current = await getGpsFix(setGpsStatus);
      if (!current) { setStatus("Ingen GPS-fix. Trykk Sjekk GPS-status og kontroller tillatelsen."); return; }
      setLocation(current);
      const lat = current.coords.latitude;
      const lon = current.coords.longitude;
      const bounds = makeBounds(lat, lon);
      const accuracy = current.coords.accuracy ? `${Math.round(current.coords.accuracy)} m` : "ukjent";
      setApiStatus(`GPS ${round5(lat)}, ${round5(lon)}. Nøyaktighet: ${accuracy}. BBox: ${boundsText(bounds)}.`);
      const result = await scanOgcBounds(bounds, setStatus);
      setReports(result.reports);
      const route = routeFrom(lat, lon, result.hits, ROUTE_COUNT);
      const useful = routeFrom(lat, lon, result.hits, 99);
      const collectionsWithHits = result.reports.filter((r) => r.raw > 0);
      const fallbackUsed = useful.length > 0 && useful.every((post) => post.collectionId === "sikringssoner");
      setApiStatus(`OGC samlinger: ${result.reports.length}. Samlinger med treff: ${collectionsWithHits.length}. Rå treff: ${result.hits.length}. Brukbare: ${useful.length}. ${fallbackUsed ? "Fallback: sikringssoner." : "Prioriterer lokaliteter/enkeltminner."}`);
      if (route.length > 0) { startWithRoute(route); return; }
      setStatus("Ingen OGC-treff i GPS-bounds. Se rapport under.");
    } catch (error) {
      console.log("OGC-test feilet:", error?.message || error);
      setStatus(`OGC-test feilet: ${error?.message || error}`);
      Alert.alert("OGC-test feilet", "Se statusfeltet for detaljer.");
    } finally { setLoading(false); }
  }

  function reset() { setScreen("MENU"); setLoading(false); setStatus("Klar."); setApiStatus(""); setPosts([]); setActiveIndex(0); setReports([]); }

  const foundCount = posts.filter((post) => post.found).length;

  if (screen === "MENU") {
    return (
      <View style={styles.menu}>
        <Text style={styles.title}>Riksantikvaren OGC-test</Text>
        <Text style={styles.menuText}>Tester ny OGC API / GeoJSON. Større søkeområde. Sikringssoner brukes bare som fallback.</Text>
        {loading ? <ActivityIndicator size="large" color="#FFFFFF" /> : null}
        <GpsStatusBox gpsStatus={gpsStatus} onRefresh={refreshGps} onSettings={openSettings} />
        <TouchableOpacity style={styles.mainButton} onPress={startOgcTest} disabled={loading}>
          <Text style={styles.buttonTitle}>START OGC GEOJSON-TEST</Text>
          <Text style={styles.buttonText}>GPS → større bbox → prioriter lokaliteter/enkeltminner</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.game}>
      <Text style={styles.title}>{screen === "REBUS" ? "Rebus GPS-test" : "OGC GeoJSON-test"}</Text>
      <Text style={styles.kicker}>Riksantikvaren OGC API</Text>
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
                <Text style={styles.source}>{activePost.source} • {activePost.collectionLabel}</Text>
                <Text style={styles.postName}>{activePost.name}</Text>
                <Text style={styles.postMeta}>Avstand: {activeDistance === null ? "venter på GPS" : `${Math.round(activeDistance)} m`}</Text>
                <Text style={styles.postMeta}>Retning: {activeBearing === null ? "venter på GPS" : directionText(activeBearing)}</Text>
                <Text style={styles.postMeta}>GPS-nøyaktighet: {location?.coords?.accuracy !== undefined ? `${Math.round(location.coords.accuracy)} m` : "ukjent"}</Text>
              </View>
            ) : null}
          </>
        ) : <CollectionReport reports={reports} />}
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

function CollectionReport({ reports }) {
  if (!reports.length) return null;
  return (
    <View style={styles.layerBox}>
      <Text style={styles.layerTitle}>Samlinger</Text>
      {reports.map((r) => (
        <View key={r.id} style={[styles.layerRow, r.raw > 0 && styles.layerHit]}>
          <Text style={styles.layerText}>{r.name}</Text>
          <Text style={styles.layerSub}>Treff: {r.raw}</Text>
          {r.error ? <Text style={styles.layerError}>{String(r.error).slice(0, 110)}</Text> : null}
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
