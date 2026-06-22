import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Location from "expo-location";
import { Magnetometer } from "expo-sensors";

const START_RADIUS = 500;
const MAX_RADIUS = 2000;
const FOUND_RADIUS = 25;
const SONAR_RADIUS = 20;
const SONAR_FOUND_RADIUS = 5;
const SONAR_COUNT = 3;
const KV_URL = "https://ws.geonorge.no/stedsnavn/v1/punkt";
const RA_URLS = [
  "https://kart.ra.no/arcgis/rest/services/Distribusjon/Kulturminner/MapServer/0/query",
  "https://kart.ra.no/arcgis/rest/services/Distribusjon/Kulturminner/MapServer/1/query"
];

const toRad = (v) => (v * Math.PI) / 180;
const toDeg = (v) => (v * 180) / Math.PI;

function distanceM(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(aLat, aLon, bLat, bLon) {
  const dLon = toRad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  const diff = Math.abs(a - b);
  return diff > 180 ? 360 - diff : diff;
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
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 80)}`);
  return JSON.parse(text);
}

function first(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function kvPoint(item) {
  const p = item?.representasjonspunkt || item?.geometry || item?.punkt;
  if (!p) return null;
  const latitude = n(p.nord) ?? n(p.latitude) ?? n(p.lat) ?? n(p.y);
  const longitude = n(p.aust) ?? n(p["øst"]) ?? n(p.longitude) ?? n(p.lon) ?? n(p.lng) ?? n(p.x);
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
}

function kvName(item, index) {
  if (typeof item?.skrivemåte === "string") return item.skrivemåte;
  if (typeof item?.skrivemate === "string") return item.skrivemate;
  if (typeof item?.navn === "string") return item.navn;
  const names = item?.stedsnavn || item?.navn;
  if (Array.isArray(names)) {
    const match = names.find((v) => v?.skrivemåte || v?.skrivemate || v?.navn);
    return match?.skrivemåte || match?.skrivemate || match?.navn || `Stedsnavn ${index + 1}`;
  }
  return `Stedsnavn ${index + 1}`;
}

async function fetchKartverket(lat, lon, radius) {
  const url = `${KV_URL}?${qs([["nord", lat], ["aust", lon], ["radius", radius], ["koordsys", 4258], ["utkoordsys", 4258], ["treffPerSide", 50], ["side", 1]])}`;
  const data = await json(url);
  const items = Array.isArray(data?.navn) ? data.navn : Array.isArray(data?.stedsnavn) ? data.stedsnavn : [];
  return items.map((raw, index) => {
    const item = raw?.properties || raw;
    const point = kvPoint(item);
    if (!point) return null;
    return { source: "Kartverket", name: kvName(item, index), ...point };
  }).filter(Boolean);
}

function raName(attributes, index) {
  return first(attributes, ["navn", "NAVN", "lokalitetsnavn", "LOKALITETSNAVN", "enkeltminneart", "ENKELTMINNEART", "kulturminneart", "KULTURMINNEART"]) || `Kulturminne ${index + 1}`;
}

async function fetchRiksantikvaren(lat, lon, radius) {
  const posts = [];
  for (const layer of RA_URLS) {
    try {
      const url = `${layer}?${qs([["f", "json"], ["where", "OBJECTID IS NOT NULL"], ["outFields", "*"], ["returnGeometry", "true"], ["geometry", `${lon},${lat}`], ["geometryType", "esriGeometryPoint"], ["inSR", 4326], ["outSR", 4326], ["spatialRel", "esriSpatialRelIntersects"], ["distance", radius], ["units", "esriSRUnit_Meter"]])}`;
      const data = await json(url);
      const features = Array.isArray(data?.features) ? data.features : [];
      features.forEach((feature, index) => {
        const latitude = n(feature?.geometry?.y);
        const longitude = n(feature?.geometry?.x);
        if (latitude === null || longitude === null) return;
        posts.push({ source: "Riksantikvaren", name: raName(feature.attributes || {}, index), latitude, longitude });
      });
    } catch (e) {
      console.log("Riksantikvaren feilet:", e?.message || e);
    }
  }
  return posts;
}

function routeFrom(lat, lon, rawPosts, radius, count) {
  const seen = new Set();
  return rawPosts
    .map((post) => ({ ...post, distanceFromStart: distanceM(lat, lon, post.latitude, post.longitude) }))
    .filter((post) => post.distanceFromStart >= 8 && post.distanceFromStart <= radius)
    .filter((post) => {
      const key = `${post.source}:${post.name.toLowerCase()}:${post.latitude.toFixed(4)}:${post.longitude.toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.distanceFromStart - b.distanceFromStart)
    .slice(0, count)
    .map((post, index) => ({ ...post, id: `${post.source}-${index + 1}`, number: index + 1, found: false }));
}

function randomPoint(lat, lon, maxRadius) {
  const distance = 4 + Math.random() * Math.max(1, maxRadius - 4);
  const angle = Math.random() * Math.PI * 2;
  const earth = 6371000;
  const latRad = toRad(lat);
  const lonRad = toRad(lon);
  const angular = distance / earth;
  const pointLat = Math.asin(Math.sin(latRad) * Math.cos(angular) + Math.cos(latRad) * Math.sin(angular) * Math.cos(angle));
  const pointLon = lonRad + Math.atan2(Math.sin(angle) * Math.sin(angular) * Math.cos(latRad), Math.cos(angular) - Math.sin(latRad) * Math.sin(pointLat));
  return { latitude: toDeg(pointLat), longitude: toDeg(pointLon) };
}

function sonarSignal(distance) {
  if (distance === null) return "Venter på GPS";
  if (distance <= SONAR_FOUND_RADIUS) return "Funnet-radius";
  if (distance <= 8) return "Veldig nær";
  if (distance <= 14) return "Nær";
  if (distance <= SONAR_RADIUS) return "Innenfor sonar-felt";
  return "Utenfor felt";
}

async function ensureGpsPermission() {
  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== "granted") permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status === "granted") return true;
  const message = permission.canAskAgain === false ? "GPS er avslått for appen. Åpne telefonens innstillinger og tillat posisjon for appen." : "Testen må ha GPS-tilgang.";
  Alert.alert("GPS kreves", message);
  return false;
}

async function getGpsPosition() {
  const allowed = await ensureGpsPermission();
  if (!allowed) return null;
  try {
    return await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  } catch (error) {
    console.log("GPS-posisjon feilet:", error?.message || error);
    Alert.alert("GPS feilet", "Klarte ikke hente GPS-posisjon. Sjekk at posisjon er slått på, og prøv ute med fri sikt.");
    return null;
  }
}

export default function App() {
  const [screen, setScreen] = useState("MENU");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Klar.");
  const [apiStatus, setApiStatus] = useState("");
  const [location, setLocation] = useState(null);
  const [posts, setPosts] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [radius, setRadius] = useState(START_RADIUS);
  const [pending, setPending] = useState(null);
  const [startPoint, setStartPoint] = useState(null);
  const [heading, setHeading] = useState(0);
  const [treasures, setTreasures] = useState([]);

  useEffect(() => {
    if (screen === "MENU") return undefined;
    let gpsSub;
    let compassSub;
    let mounted = true;
    async function watch() {
      try {
        const allowed = await ensureGpsPermission();
        if (!allowed || !mounted) return;
        gpsSub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 1 }, (next) => mounted && setLocation(next));
        if (screen === "SONAR") {
          Magnetometer.setUpdateInterval(150);
          compassSub = Magnetometer.addListener((data) => {
            const angle = Math.atan2(data.y, data.x) * (180 / Math.PI);
            if (mounted) setHeading((angle + 360) % 360);
          });
        }
      } catch (error) {
        console.log("Sporing feilet:", error?.message || error);
        if (mounted) setStatus("GPS/kompass-sporing feilet. Sjekk tillatelser og prøv igjen.");
      }
    }
    watch();
    return () => {
      mounted = false;
      if (gpsSub) gpsSub.remove();
      if (compassSub) compassSub.remove();
    };
  }, [screen]);

  const activePost = posts[activeIndex] || null;
  const activeDistance = useMemo(() => {
    if (!location || !activePost) return null;
    return distanceM(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude);
  }, [location, activePost]);
  const activeBearing = useMemo(() => {
    if (!location || !activePost) return null;
    return bearing(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude);
  }, [location, activePost]);

  const closestTreasure = useMemo(() => {
    if (!location) return null;
    const open = treasures.filter((t) => !t.found);
    if (open.length === 0) return null;
    return open.map((t) => {
      const d = distanceM(location.coords.latitude, location.coords.longitude, t.latitude, t.longitude);
      const b = bearing(location.coords.latitude, location.coords.longitude, t.latitude, t.longitude);
      return { ...t, distance: d, bearing: b, diff: angleDiff(heading, b) };
    }).sort((a, b) => a.distance - b.distance)[0];
  }, [location, treasures, heading]);

  function startWithRoute(route, usedRadius) {
    setPending(null);
    setRadius(usedRadius);
    setPosts(route);
    setActiveIndex(0);
    setScreen("REBUS");
    setStatus(route.length === 1 ? `1-post test klar. Gå til post 1: ${route[0].name}` : `Sløyfe klar. Gå til post 1: ${route[0].name}`);
  }

  async function search(radiusToUse = START_RADIUS, existingStartPoint = null) {
    setLoading(true);
    setPending(null);
    setPosts([]);
    setTreasures([]);
    setActiveIndex(0);
    setStatus("Søker etter ekte poster...");
    setApiStatus(`Søkeradius: ${radiusToUse} m`);
    try {
      const current = existingStartPoint || await getGpsPosition();
      if (!current) {
        setStatus("GPS-tilgang mangler. Gi posisjonstillatelse og prøv igjen.");
        return;
      }
      setLocation(current);
      setStartPoint(current);
      const lat = current.coords.latitude;
      const lon = current.coords.longitude;
      const [kvResult, raResult] = await Promise.allSettled([fetchKartverket(lat, lon, radiusToUse), fetchRiksantikvaren(lat, lon, radiusToUse)]);
      const kv = kvResult.status === "fulfilled" ? kvResult.value : [];
      const ra = raResult.status === "fulfilled" ? raResult.value : [];
      const all = [...kv, ...ra];
      const two = routeFrom(lat, lon, all, radiusToUse, 2);
      const one = routeFrom(lat, lon, all, radiusToUse, 1);
      setScreen("REBUS");
      setRadius(radiusToUse);
      setApiStatus(`Radius: ${radiusToUse} m. Kartverket: ${kv.length}. Riksantikvaren: ${ra.length}.`);
      if (two.length === 2) startWithRoute(two, radiusToUse);
      else {
        setPending({ one, canUseOne: one.length === 1, canSearchLarger: radiusToUse < MAX_RADIUS, radius: radiusToUse });
        if (one.length === 1) setStatus(`Fant bare 1 post innen ${radiusToUse} m. Velg større radius eller bruk 1 post.`);
        else if (radiusToUse < MAX_RADIUS) setStatus(`Fant ingen poster innen ${radiusToUse} m. Velg større radius.`);
        else setStatus(`Fant ingen poster innen ${radiusToUse} m. Flytt deg og prøv igjen.`);
      }
    } catch (e) {
      console.log("Rebus feilet:", e?.message || e);
      Alert.alert("Rebus feilet", "Sjekk GPS og nettverk.");
      setStatus("Klarte ikke starte API-test.");
    } finally {
      setLoading(false);
    }
  }

  async function startSonar() {
    setLoading(true);
    setPending(null);
    setPosts([]);
    setTreasures([]);
    setApiStatus("");
    setStatus("Starter Sonar-test...");
    try {
      const current = await getGpsPosition();
      if (!current) {
        setStatus("GPS-tilgang mangler. Gi posisjonstillatelse og prøv igjen.");
        return;
      }
      const lat = current.coords.latitude;
      const lon = current.coords.longitude;
      const nextTreasures = Array.from({ length: SONAR_COUNT }).map((_, index) => ({ id: `treasure-${index + 1}`, name: `Skatt ${index + 1}`, found: false, ...randomPoint(lat, lon, SONAR_RADIUS) }));
      setLocation(current);
      setTreasures(nextTreasures);
      setScreen("SONAR");
      setStatus("Sonar klar. Gå sakte og snu deg rolig rundt.");
    } catch (e) {
      console.log("Sonar feilet:", e?.message || e);
      Alert.alert("Sonar feilet", "Sjekk GPS og prøv igjen ute.");
      setStatus("Klarte ikke starte Sonar-test.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (screen !== "REBUS" || !location || !activePost || activePost.found) return;
    const d = distanceM(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude);
    if (d <= FOUND_RADIUS) {
      const updated = posts.map((post, index) => index === activeIndex ? { ...post, found: true } : post);
      setPosts(updated);
      const nextIndex = updated.findIndex((post) => !post.found);
      if (nextIndex === -1) setStatus("Post funnet. Alle postene er funnet.");
      else {
        setActiveIndex(nextIndex);
        setStatus(`Post ${activePost.number} funnet. Gå til post ${updated[nextIndex].number}: ${updated[nextIndex].name}`);
      }
      return;
    }
    setStatus(`Gå mot ${directionText(bearing(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude))}. Avstand: ${Math.round(d)} meter.`);
  }, [location, screen, activeIndex, activePost, posts]);

  useEffect(() => {
    if (screen !== "SONAR" || !closestTreasure) return;
    if (closestTreasure.distance <= SONAR_FOUND_RADIUS) {
      const updated = treasures.map((t) => t.id === closestTreasure.id ? { ...t, found: true } : t);
      setTreasures(updated);
      const remaining = updated.filter((t) => !t.found).length;
      setStatus(remaining === 0 ? "Alle skattene er funnet." : `${closestTreasure.name} funnet. ${remaining} igjen.`);
      return;
    }
    const direction = closestTreasure.diff <= 35 ? "Riktig retning" : "Snu deg rolig rundt";
    setStatus(`${sonarSignal(closestTreasure.distance)}. ${direction}.`);
  }, [screen, closestTreasure, treasures]);

  function reset() {
    setScreen("MENU");
    setLoading(false);
    setStatus("Klar.");
    setApiStatus("");
    setPosts([]);
    setTreasures([]);
    setActiveIndex(0);
    setRadius(START_RADIUS);
    setPending(null);
    setStartPoint(null);
  }

  if (screen === "MENU") {
    return (
      <View style={styles.menu}>
        <Text style={styles.title}>GPS Test</Text>
        <Text style={styles.menuText}>Velg Rebus med ekte API-poster eller Sonar med tre GPS-skatter innen 20 meter.</Text>
        {loading ? <ActivityIndicator size="large" color="#FFFFFF" /> : null}
        <TouchableOpacity style={styles.mainButton} onPress={() => search(START_RADIUS)} disabled={loading}>
          <Text style={styles.buttonTitle}>START REBUS API-TEST</Text>
          <Text style={styles.buttonText}>GPS • Kartverket • Riksantikvaren</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.mainButton, styles.sonarButton]} onPress={startSonar} disabled={loading}>
          <Text style={styles.buttonTitle}>START SONAR TEST</Text>
          <Text style={styles.buttonText}>GPS • 3 skatter • 20 meter</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const foundCount = posts.filter((post) => post.found).length;
  const sonarFound = treasures.filter((t) => t.found).length;
  const nextRadius = pending ? Math.min(pending.radius * 2, MAX_RADIUS) : null;

  return (
    <ScrollView contentContainerStyle={[styles.game, screen === "SONAR" && styles.sonarGame]}>
      <Text style={styles.title}>{screen === "SONAR" ? "Sonar GPS-test" : "Rebus API-test"}</Text>
      <View style={styles.card}>
        {loading ? <ActivityIndicator size="large" color="#1E3A8A" /> : null}
        <Text style={styles.status}>{status}</Text>

        {screen === "REBUS" ? (
          <>
            <Text style={styles.meta}>{apiStatus}</Text>
            <Text style={styles.meta}>Søkeradius: {radius} m</Text>
            <Text style={styles.meta}>Poster funnet: {foundCount} / {posts.length}</Text>
            {pending ? (
              <View style={styles.choiceCard}>
                <Text style={styles.choiceTitle}>Velg videre test</Text>
                <Text style={styles.choiceText}>Samme startpunkt brukes. Du slipper å gå tilbake og starte på nytt.</Text>
                {pending.canSearchLarger ? <TouchableOpacity style={styles.choiceButton} onPress={() => search(nextRadius, startPoint)} disabled={loading}><Text style={styles.choiceButtonText}>Søk større radius ({nextRadius} m)</Text></TouchableOpacity> : null}
                {pending.canUseOne ? <TouchableOpacity style={[styles.choiceButton, styles.oneButton]} onPress={() => startWithRoute(pending.one, pending.radius)} disabled={loading}><Text style={styles.choiceButtonText}>Bruk 1 post</Text></TouchableOpacity> : null}
              </View>
            ) : null}
            {activePost && !activePost.found ? (
              <View style={styles.postCard}>
                <Text style={styles.source}>{activePost.source}</Text>
                <Text style={styles.postName}>{activePost.name}</Text>
                <Text style={styles.postMeta}>Avstand: {activeDistance === null ? "venter på GPS" : `${Math.round(activeDistance)} m`}</Text>
                <Text style={styles.postMeta}>Retning: {activeBearing === null ? "venter på GPS" : directionText(activeBearing)}</Text>
                <Text style={styles.postMeta}>GPS-nøyaktighet: {location?.coords?.accuracy ? `${Math.round(location.coords.accuracy)} m` : "ukjent"}</Text>
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.postCard}>
            <Text style={styles.source}>SONAR</Text>
            <Text style={styles.postName}>{sonarFound} / {treasures.length} skatter funnet</Text>
            <Text style={styles.postMeta}>Nærmeste: {closestTreasure ? `${Math.round(closestTreasure.distance)} m` : "ingen igjen"}</Text>
            <Text style={styles.postMeta}>Signal: {closestTreasure ? sonarSignal(closestTreasure.distance) : "ferdig"}</Text>
            <Text style={styles.postMeta}>Retning: {closestTreasure ? directionText(closestTreasure.bearing) : "ferdig"}</Text>
            <Text style={styles.postMeta}>Peker mot skatt: {closestTreasure ? `${Math.round(closestTreasure.diff)}° avvik` : "ferdig"}</Text>
            <Text style={styles.postMeta}>Kompass heading: {Math.round(heading)}°</Text>
            <Text style={styles.postMeta}>GPS-nøyaktighet: {location?.coords?.accuracy ? `${Math.round(location.coords.accuracy)} m` : "ukjent"}</Text>
          </View>
        )}
      </View>
      <TouchableOpacity style={styles.backButton} onPress={reset}>
        <Text style={styles.backText}>Tilbake</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  menu: { flex: 1, backgroundColor: "#0F172A", justifyContent: "center", alignItems: "center", padding: 24 },
  game: { flexGrow: 1, backgroundColor: "#1E3A8A", padding: 20, justifyContent: "center", alignItems: "center" },
  sonarGame: { backgroundColor: "#064E3B" },
  title: { color: "#FFFFFF", fontSize: 32, fontWeight: "900", textAlign: "center", marginBottom: 18 },
  menuText: { color: "#94A3B8", fontSize: 16, lineHeight: 23, textAlign: "center", marginBottom: 28 },
  mainButton: { width: "100%", backgroundColor: "#3B82F6", borderRadius: 18, padding: 24, alignItems: "center", marginTop: 18 },
  sonarButton: { backgroundColor: "#10B981" },
  buttonTitle: { color: "#FFFFFF", fontSize: 21, fontWeight: "900" },
  buttonText: { color: "rgba(255,255,255,0.82)", marginTop: 6 },
  card: { width: "100%", backgroundColor: "#FFFFFF", borderRadius: 20, padding: 22, alignItems: "center" },
  status: { color: "#1F2937", fontSize: 21, fontWeight: "800", lineHeight: 29, textAlign: "center", marginTop: 8 },
  meta: { color: "#64748B", fontSize: 14, marginTop: 8, textAlign: "center" },
  choiceCard: { width: "100%", backgroundColor: "#EEF2FF", borderRadius: 16, padding: 16, marginTop: 18 },
  choiceTitle: { color: "#1E3A8A", fontSize: 18, fontWeight: "900", textAlign: "center" },
  choiceText: { color: "#334155", fontSize: 15, lineHeight: 21, textAlign: "center", marginTop: 6, marginBottom: 8 },
  choiceButton: { minHeight: 48, borderRadius: 14, backgroundColor: "#2563EB", alignItems: "center", justifyContent: "center", marginTop: 10 },
  oneButton: { backgroundColor: "#10B981" },
  choiceButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  postCard: { width: "100%", backgroundColor: "#F8FAFC", borderColor: "#E2E8F0", borderWidth: 1, borderRadius: 16, padding: 16, marginTop: 18 },
  source: { color: "#2563EB", fontSize: 13, fontWeight: "900", textTransform: "uppercase", marginBottom: 5 },
  postName: { color: "#0F172A", fontSize: 19, lineHeight: 25, fontWeight: "900", marginBottom: 10 },
  postMeta: { color: "#334155", fontSize: 15, lineHeight: 22, fontWeight: "600" },
  backButton: { marginTop: 40, borderBottomColor: "#CBD5E1", borderBottomWidth: 1, paddingBottom: 5 },
  backText: { color: "#CBD5E1", fontSize: 16, fontWeight: "700" }
});