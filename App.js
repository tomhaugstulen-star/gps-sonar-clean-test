import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Easing, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Location from "expo-location";
import { Magnetometer } from "expo-sensors";

const REBUS_RADIUS = 500;
const REBUS_MAX_RADIUS = 2000;
const REBUS_FOUND_RADIUS = 25;
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
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
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
  if (distance === null || distance === undefined) return { label: "Søker", helper: "Venter på GPS-signal.", pulse: "Signal søker" };
  if (distance <= SONAR_FOUND_RADIUS) return { label: "Svært nær", helper: "Skatten er svært nær. Se deg rolig rundt.", pulse: "Pulsen er svært tett" };
  if (distance <= 8) return { label: "Sterkt signal", helper: "Sterkt signal. Utforsk nærområdet rolig.", pulse: "Pulsen øker" };
  if (distance <= 14) return { label: "Middels signal", helper: "Signalet øker. Du nærmer deg.", pulse: "Du nærmer deg" };
  return { label: "Svakt signal", helper: "Beveg deg rolig i søkeområdet.", pulse: "Signal søker" };
}

function signalPercent(distance) {
  if (distance === null || distance === undefined) return "12%";
  const percent = 100 - (distance / 80) * 100;
  return `${Math.max(12, Math.min(96, Math.round(percent)))}%`;
}

async function readGpsStatus() {
  const servicesEnabled = await Location.hasServicesEnabledAsync();
  const permission = await Location.getForegroundPermissionsAsync();
  return {
    servicesEnabled,
    status: permission.status,
    granted: permission.granted,
    canAskAgain: permission.canAskAgain,
    expires: String(permission.expires)
  };
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
    status = {
      servicesEnabled: await Location.hasServicesEnabledAsync(),
      status: requested.status,
      granted: requested.granted,
      canAskAgain: requested.canAskAgain,
      expires: String(requested.expires)
    };
    setGpsStatus?.(status);
  }

  if (status.status === "granted") return true;

  const message = status.canAskAgain === false
    ? "Telefonen sier at appen ikke kan spørre på nytt. Åpne innstillinger og gi posisjon til Expo Go."
    : "Testen må ha GPS-tilgang.";
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

    const timeout = setTimeout(() => {
      finish(null);
    }, 12000);

    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
      (next) => {
        clearTimeout(timeout);
        finish(next);
      }
    )
      .then((subscription) => {
        sub = subscription;
      })
      .catch((error) => {
        clearTimeout(timeout);
        console.log("GPS first fix feilet:", error?.message || error);
        Alert.alert("GPS feilet", "Telefonen nekter fortsatt GPS. Trykk Sjekk GPS-status og se hva status viser.");
        finish(null);
      });
  });
}

function SonarPulse({ distance, isClose }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let interval = 1600;
    if (distance <= 5) interval = 420;
    else if (distance <= 8) interval = 620;
    else if (distance <= 14) interval = 950;

    const runPulse = () => {
      pulse.setValue(1);
      Animated.timing(pulse, { toValue: 3.8, duration: Math.min(interval, 700), easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    };

    runPulse();
    const timer = setInterval(runPulse, interval);
    return () => clearInterval(timer);
  }, [distance, pulse]);

  return (
    <View style={styles.sonarWrap}>
      <Animated.View style={[styles.sonarWave, { transform: [{ scale: pulse }], opacity: pulse.interpolate({ inputRange: [1, 3.8], outputRange: [0.68, 0] }) }]} />
      <View style={styles.sonarRingOuter} />
      <View style={styles.sonarRingMid} />
      <View style={styles.sonarRingInner} />
      <View style={[styles.sonarCore, isClose && styles.sonarCoreClose]} />
    </View>
  );
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
  const [radius, setRadius] = useState(REBUS_RADIUS);
  const [pending, setPending] = useState(null);
  const [startPoint, setStartPoint] = useState(null);
  const [heading, setHeading] = useState(0);
  const [treasures, setTreasures] = useState([]);
  const [sonarSearching, setSonarSearching] = useState(false);

  useEffect(() => {
    readGpsStatus().then(setGpsStatus).catch(() => {});
  }, []);

  useEffect(() => {
    const shouldTrack = screen === "REBUS" || (screen === "SONAR" && sonarSearching);
    if (!shouldTrack) return undefined;

    let gpsSub;
    let compassSub;
    let mounted = true;

    async function watch() {
      try {
        const allowed = await ensureGpsPermission(setGpsStatus);
        if (!allowed || !mounted) return;

        gpsSub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 1 },
          (next) => mounted && setLocation(next)
        );

        if (screen === "SONAR") {
          Magnetometer.setUpdateInterval(150);
          compassSub = Magnetometer.addListener((data) => {
            const angle = Math.atan2(data.y, data.x) * (180 / Math.PI);
            if (mounted) setHeading((angle + 360) % 360);
          });
        }
      } catch (error) {
        console.log("Sporing feilet:", error?.message || error);
        if (mounted) setStatus("GPS/kompass-sporing feilet. Sjekk GPS-status.");
      }
    }

    watch();
    return () => {
      mounted = false;
      if (gpsSub) gpsSub.remove();
      if (compassSub) compassSub.remove();
    };
  }, [screen, sonarSearching]);

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

  const sonar = sonarSignal(closestTreasure?.distance);
  const canOpenTreasure = Boolean(closestTreasure && closestTreasure.distance <= SONAR_FOUND_RADIUS);

  async function refreshGps() {
    try {
      setGpsStatus(await readGpsStatus());
    } catch (error) {
      setStatus(`Klarte ikke lese GPS-status: ${error?.message || error}`);
    }
  }

  function openSettings() {
    Linking.openSettings().catch(() => Alert.alert("Innstillinger", "Klarte ikke åpne app-innstillinger."));
  }

  function startWithRoute(route, usedRadius) {
    setPending(null);
    setRadius(usedRadius);
    setPosts(route);
    setActiveIndex(0);
    setScreen("REBUS");
    setStatus(route.length === 1 ? `1-post test klar. Gå til post 1: ${route[0].name}` : `Sløyfe klar. Gå til post 1: ${route[0].name}`);
  }

  async function search(radiusToUse = REBUS_RADIUS, existingStartPoint = null) {
    setLoading(true);
    setPending(null);
    setPosts([]);
    setTreasures([]);
    setSonarSearching(false);
    setActiveIndex(0);
    setStatus("Søker etter ekte poster...");
    setApiStatus(`Søkeradius: ${radiusToUse} m`);
    try {
      const current = existingStartPoint || await getGpsFix(setGpsStatus);
      if (!current) {
        setStatus("Ingen GPS-fix. Trykk Sjekk GPS-status og kontroller tillatelsen.");
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
        setPending({ one, canUseOne: one.length === 1, canSearchLarger: radiusToUse < REBUS_MAX_RADIUS, radius: radiusToUse });
        if (one.length === 1) setStatus(`Fant bare 1 post innen ${radiusToUse} m. Velg større radius eller bruk 1 post.`);
        else if (radiusToUse < REBUS_MAX_RADIUS) setStatus(`Fant ingen poster innen ${radiusToUse} m. Velg større radius.`);
        else setStatus(`Fant ingen poster innen ${radiusToUse} m. Flytt deg og prøv igjen.`);
      }
    } catch (e) {
      console.log("Rebus feilet:", e?.message || e);
      Alert.alert("Rebus feilet", "Sjekk GPS-status og nettverk.");
      setStatus("Klarte ikke starte API-test.");
    } finally {
      setLoading(false);
    }
  }

  function openSonarPage() {
    setScreen("SONAR");
    setLoading(false);
    setStatus("Trykk Søk etter skatt for å starte GPS-sonar.");
    setApiStatus("");
    setPosts([]);
    setPending(null);
    setTreasures([]);
    setSonarSearching(false);
  }

  async function startSonarSearch() {
    setLoading(true);
    setStatus("Henter GPS og lager sonarområde...");
    setTreasures([]);
    try {
      const current = await getGpsFix(setGpsStatus);
      if (!current) {
        setStatus("Ingen GPS-fix. Trykk Sjekk GPS-status og kontroller tillatelsen.");
        return;
      }

      const lat = current.coords.latitude;
      const lon = current.coords.longitude;
      const nextTreasures = Array.from({ length: SONAR_COUNT }).map((_, index) => ({ id: `treasure-${index + 1}`, name: `Skatt ${index + 1}`, found: false, ...randomPoint(lat, lon, SONAR_RADIUS) }));
      setLocation(current);
      setTreasures(nextTreasures);
      setSonarSearching(true);
      setStatus("Sonar søker. Legg mobilen i lomma eller hold den rolig og følg signalet.");
    } catch (e) {
      console.log("Sonar feilet:", e?.message || e);
      Alert.alert("Sonar feilet", "Sjekk GPS-status og prøv igjen ute.");
      setStatus("Klarte ikke starte Sonar-test.");
    } finally {
      setLoading(false);
    }
  }

  function stopSonarSearch() {
    setSonarSearching(false);
    setStatus("Sonar stoppet. Trykk Søk etter skatt for å starte igjen.");
  }

  function openTreasure() {
    if (!closestTreasure || !canOpenTreasure) {
      Alert.alert("Ikke nær nok", "Gå nærmere skatten for å åpne den.");
      return;
    }
    const updated = treasures.map((t) => t.id === closestTreasure.id ? { ...t, found: true } : t);
    setTreasures(updated);
    const remaining = updated.filter((t) => !t.found).length;
    if (remaining === 0) {
      setSonarSearching(false);
      setStatus("Alle skattene er funnet.");
    } else {
      setStatus(`${closestTreasure.name} funnet. ${remaining} igjen.`);
    }
  }

  useEffect(() => {
    if (screen !== "REBUS" || !location || !activePost || activePost.found) return;
    const d = distanceM(location.coords.latitude, location.coords.longitude, activePost.latitude, activePost.longitude);
    if (d <= REBUS_FOUND_RADIUS) {
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
    if (screen !== "SONAR" || !sonarSearching || !closestTreasure) return;
    const direction = closestTreasure.diff <= 35 ? "Riktig retning" : "Snu deg rolig rundt";
    setStatus(`${sonar.helper} ${direction}.`);
  }, [screen, sonarSearching, closestTreasure, sonar.helper]);

  function reset() {
    setScreen("MENU");
    setLoading(false);
    setStatus("Klar.");
    setApiStatus("");
    setPosts([]);
    setTreasures([]);
    setSonarSearching(false);
    setActiveIndex(0);
    setRadius(REBUS_RADIUS);
    setPending(null);
    setStartPoint(null);
  }

  const foundCount = posts.filter((post) => post.found).length;
  const sonarFound = treasures.filter((t) => t.found).length;
  const nextRadius = pending ? Math.min(pending.radius * 2, REBUS_MAX_RADIUS) : null;

  if (screen === "MENU") {
    return (
      <View style={styles.menu}>
        <Text style={styles.title}>GPS Test</Text>
        <Text style={styles.menuText}>Test først GPS-status. Deretter start Rebus eller Sonar.</Text>
        {loading ? <ActivityIndicator size="large" color="#FFFFFF" /> : null}
        <GpsStatusBox gpsStatus={gpsStatus} onRefresh={refreshGps} onSettings={openSettings} />
        <TouchableOpacity style={styles.mainButton} onPress={() => search(REBUS_RADIUS)} disabled={loading}>
          <Text style={styles.buttonTitle}>START REBUS API-TEST</Text>
          <Text style={styles.buttonText}>GPS • Kartverket • Riksantikvaren</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.mainButton, styles.sonarButton]} onPress={openSonarPage} disabled={loading}>
          <Text style={styles.buttonTitle}>ÅPNE SONAR-SIDE</Text>
          <Text style={styles.buttonText}>Søk etter skatt • Stopp • Åpne skatt</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={[styles.game, screen === "SONAR" && styles.sonarGame]}>
      <Text style={styles.title}>{screen === "SONAR" ? "Finn skatten" : "Rebus API-test"}</Text>
      <Text style={styles.kicker}>{screen === "SONAR" ? "Skattejakt • Sonar" : "Rebus"}</Text>
      <View style={styles.card}>
        {loading ? <ActivityIndicator size="large" color="#F59E0B" /> : null}
        <Text style={styles.status}>{status}</Text>
        <GpsStatusBox gpsStatus={gpsStatus} onRefresh={refreshGps} onSettings={openSettings} compact />

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
          <>
            <View style={styles.sonarHeaderRow}>
              <View>
                <Text style={styles.cardTitle}>SONAR</Text>
                <Text style={styles.cardSubtitle}>Lyd- og signalvisning</Text>
              </View>
              <View style={styles.badge}><Text style={styles.badgeText}>{sonar.label}</Text></View>
            </View>
            <Text style={styles.modeText}>Legg mobilen i lomma og følg signalet. Jo sterkere pulsen blir, jo nærmere er du.</Text>
            <SonarPulse distance={closestTreasure?.distance} isClose={canOpenTreasure} />
            <View style={styles.metricGrid}>
              <View style={styles.metricBox}><Text style={styles.metricLabel}>Signalnivå</Text><Text style={styles.metricValue}>{sonar.label}</Text></View>
              <View style={styles.metricBox}><Text style={styles.metricLabel}>Puls</Text><Text style={styles.metricValue}>{sonar.pulse}</Text></View>
            </View>
            <View style={styles.signalBar}><View style={[styles.signalFill, { width: signalPercent(closestTreasure?.distance) }, closestTreasure?.distance <= 14 && styles.signalFillOn, closestTreasure?.distance <= 8 && styles.signalFillStrong, closestTreasure?.distance <= 5 && styles.signalFillVeryStrong]} /></View>
            <Text style={styles.meta}>Skatter funnet: {sonarFound} / {treasures.length}</Text>
            <Text style={styles.meta}>Nærmeste: {closestTreasure ? `${Math.round(closestTreasure.distance)} m` : "ingen aktiv skatt"}</Text>
            <Text style={styles.meta}>Retning: {closestTreasure ? directionText(closestTreasure.bearing) : "ingen"}</Text>
            <Text style={styles.meta}>Peker mot skatt: {closestTreasure ? `${Math.round(closestTreasure.diff)}° avvik` : "ingen"}</Text>
            <Text style={styles.meta}>Kompass heading: {Math.round(heading)}°</Text>
            <Text style={styles.meta}>GPS-nøyaktighet: {location?.coords?.accuracy ? `${Math.round(location.coords.accuracy)} m` : "ukjent"}</Text>
            {canOpenTreasure ? <View style={styles.readyBox}><Text style={styles.readyTitle}>Skatten er svært nær</Text><Text style={styles.readyText}>Se deg rolig rundt. Åpne skatten når du har funnet stedet.</Text></View> : <Text style={styles.helperText}>Skatten kan åpnes når du er svært nær.</Text>}
            <TouchableOpacity style={styles.secondaryButton} onPress={startSonarSearch} disabled={loading}><Text style={styles.secondaryButtonText}>Søk etter skatt</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={stopSonarSearch} disabled={!sonarSearching}><Text style={styles.secondaryButtonText}>Stopp søk</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.primaryButton, !canOpenTreasure && styles.primaryButtonDisabled]} onPress={openTreasure} disabled={!canOpenTreasure}><Text style={[styles.primaryButtonText, !canOpenTreasure && styles.primaryButtonTextDisabled]}>Åpne skatt</Text></TouchableOpacity>
          </>
        )}
      </View>
      <TouchableOpacity style={styles.backButton} onPress={reset}>
        <Text style={styles.backText}>Tilbake</Text>
      </TouchableOpacity>
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

const styles = StyleSheet.create({
  menu: { flex: 1, backgroundColor: "#0F172A", justifyContent: "center", alignItems: "center", padding: 24 },
  game: { flexGrow: 1, backgroundColor: "#1E3A8A", padding: 20, justifyContent: "center", alignItems: "center" },
  sonarGame: { backgroundColor: "#0F172A" },
  title: { color: "#FFFFFF", fontSize: 32, fontWeight: "900", textAlign: "center", marginBottom: 8 },
  kicker: { color: "#F59E0B", fontSize: 13, fontWeight: "900", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 16 },
  menuText: { color: "#94A3B8", fontSize: 16, lineHeight: 23, textAlign: "center", marginBottom: 18 },
  mainButton: { width: "100%", backgroundColor: "#3B82F6", borderRadius: 18, padding: 24, alignItems: "center", marginTop: 18 },
  sonarButton: { backgroundColor: "#10B981" },
  buttonTitle: { color: "#FFFFFF", fontSize: 21, fontWeight: "900" },
  buttonText: { color: "rgba(255,255,255,0.82)", marginTop: 6 },
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
  oneButton: { backgroundColor: "#10B981" },
  choiceButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  postCard: { width: "100%", backgroundColor: "#F8FAFC", borderColor: "#E2E8F0", borderWidth: 1, borderRadius: 16, padding: 16, marginTop: 18 },
  source: { color: "#2563EB", fontSize: 13, fontWeight: "900", textTransform: "uppercase", marginBottom: 5 },
  postName: { color: "#0F172A", fontSize: 19, lineHeight: 25, fontWeight: "900", marginBottom: 10 },
  postMeta: { color: "#334155", fontSize: 15, lineHeight: 22, fontWeight: "600" },
  sonarHeaderRow: { width: "100%", flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 },
  cardTitle: { color: "#F59E0B", fontSize: 18, fontWeight: "900" },
  cardSubtitle: { color: "#94A3B8", fontSize: 13, fontWeight: "700", marginTop: 3 },
  badge: { minHeight: 32, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "rgba(245, 158, 11, 0.16)", borderWidth: 1, borderColor: "rgba(245, 158, 11, 0.35)", alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#FDE68A", fontSize: 12, fontWeight: "900" },
  modeText: { color: "#E2E8F0", fontSize: 15, lineHeight: 22, marginBottom: 16, textAlign: "center" },
  sonarWrap: { width: 290, height: 290, marginTop: 18, marginBottom: 28, alignItems: "center", justifyContent: "center" },
  sonarWave: { width: 60, height: 60, borderRadius: 30, borderWidth: 2, borderColor: "#F59E0B", backgroundColor: "rgba(245, 158, 11, 0.10)", position: "absolute" },
  sonarRingOuter: { position: "absolute", width: 278, height: 278, borderRadius: 139, borderWidth: 2, borderColor: "rgba(245, 158, 11, 0.45)" },
  sonarRingMid: { position: "absolute", width: 212, height: 212, borderRadius: 106, borderWidth: 2, borderColor: "rgba(245, 158, 11, 0.45)" },
  sonarRingInner: { position: "absolute", width: 144, height: 144, borderRadius: 72, borderWidth: 2, borderColor: "rgba(245, 158, 11, 0.45)" },
  sonarCore: { width: 62, height: 62, borderRadius: 31, backgroundColor: "#F59E0B", shadowColor: "#F59E0B", shadowOpacity: 0.35, shadowRadius: 14, elevation: 8 },
  sonarCoreClose: { backgroundColor: "#22C55E" },
  metricGrid: { width: "100%", flexDirection: "row", gap: 12, marginBottom: 12 },
  metricBox: { flex: 1, backgroundColor: "#334155", borderRadius: 16, padding: 14 },
  metricLabel: { color: "#94A3B8", fontSize: 12, fontWeight: "800", marginBottom: 5 },
  metricValue: { color: "#E2E8F0", fontSize: 16, fontWeight: "900" },
  signalBar: { width: "100%", height: 16, borderRadius: 999, backgroundColor: "#334155", overflow: "hidden", marginTop: 10, marginBottom: 12 },
  signalFill: { height: "100%", backgroundColor: "#475569" },
  signalFillOn: { backgroundColor: "#94A3B8" },
  signalFillStrong: { backgroundColor: "#F59E0B" },
  signalFillVeryStrong: { backgroundColor: "#22C55E" },
  helperText: { color: "#94A3B8", fontSize: 14, lineHeight: 20, marginVertical: 12, textAlign: "center" },
  readyBox: { width: "100%", backgroundColor: "rgba(34, 197, 94, 0.14)", borderRadius: 16, padding: 16, marginVertical: 12, borderWidth: 1, borderColor: "rgba(34, 197, 94, 0.42)" },
  readyTitle: { color: "#BBF7D0", fontSize: 16, fontWeight: "900", marginBottom: 4 },
  readyText: { color: "#E2E8F0", fontSize: 14, lineHeight: 20 },
  secondaryButton: { width: "100%", minHeight: 54, borderRadius: 16, backgroundColor: "#334155", alignItems: "center", justifyContent: "center", marginTop: 12, paddingHorizontal: 16 },
  secondaryButtonText: { color: "#E2E8F0", fontSize: 17, fontWeight: "900" },
  primaryButton: { width: "100%", minHeight: 54, borderRadius: 16, backgroundColor: "#F59E0B", alignItems: "center", justifyContent: "center", marginTop: 12 },
  primaryButtonDisabled: { backgroundColor: "#334155" },
  primaryButtonText: { color: "#111827", fontSize: 17, fontWeight: "900" },
  primaryButtonTextDisabled: { color: "#94A3B8" },
  backButton: { marginTop: 40, borderBottomColor: "#CBD5E1", borderBottomWidth: 1, paddingBottom: 5 },
  backText: { color: "#CBD5E1", fontSize: 16, fontWeight: "700" }
});
