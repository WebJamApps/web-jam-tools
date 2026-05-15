(async () => {
  try {
    const response = await fetch('https://www.joshandmariamusic.com/song', {
      headers: { 'Accept': 'application/json' }
    });
    const data = await response.json();
    if (Array.isArray(data)) {
      console.log('Found ' + data.length + ' songs.');
      const targets = ['Dark Light', 'Misty Rainy Morning', 'Good Enough'];
      const results = data.filter(s => targets.includes(s.title));
      console.log('Results:', JSON.stringify(results, null, 2));
    } else {
      console.log('Response data is not an array.');
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
})();
