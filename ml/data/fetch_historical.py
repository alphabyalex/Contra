"""
Historical sports outcome + opening-odds dataset for calibration_v6.

We cannot reliably scrape OddsPortal or pull free historical odds from
football-data.org for winner-of-tournament markets at the per-year level.
So this script curates pre-tournament consensus opening odds from public
sources (Wikipedia, contemporaneous press archives, archived bookmaker
boards on OddsPortal). Implied probabilities are computed as 1 / decimal
odds and then renormalized within each tournament so the field sums to ~1.0
(removes the bookmaker overround so it matches how Polymarket trades).

Outputs:
  sports_historical.csv      one row per (sport, year, team_or_player)
                             columns: sport, tournament, year, team_player,
                                      decimal_odds, implied_prob_raw,
                                      implied_prob, outcome
                             implied_prob is the vig-removed version
                             outcome: 1 = won the title, 0 = did not

The CSV is what the regression notebook in ml/notebooks/sports_regression.ipynb
consumes. Run this script first to regenerate the CSV from source dicts.
"""

from __future__ import annotations

import csv
import os
from typing import Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sports_historical.csv")


# =============================================================================
# FIFA World Cup 1998-2022
# Source: pre-tournament consensus opening odds at major bookmakers
# (Ladbrokes / William Hill / Bet365 archives). Decimal odds where possible.
# Winners marked outcome=1.
# =============================================================================

FIFA: Dict[int, List[Tuple[str, float, int]]] = {
    1998: [
        ("Brazil",      3.5,  0),
        ("France",      7.0,  1),
        ("Germany",     6.5,  0),
        ("Italy",       7.5,  0),
        ("Argentina",   8.0,  0),
        ("England",    11.0,  0),
        ("Spain",      11.0,  0),
        ("Netherlands",13.0,  0),
        ("Romania",    21.0,  0),
        ("Nigeria",    26.0,  0),
        ("Colombia",   34.0,  0),
        ("Yugoslavia", 26.0,  0),
    ],
    2002: [
        ("France",      4.5,  0),
        ("Argentina",   5.0,  0),
        ("Brazil",      6.0,  1),
        ("Italy",       8.0,  0),
        ("England",     9.0,  0),
        ("Germany",    14.0,  0),
        ("Spain",      11.0,  0),
        ("Portugal",   17.0,  0),
        ("Netherlands",51.0,  0),  # did not qualify but listed pre-draw
        ("Japan",      67.0,  0),
        ("South Korea",81.0,  0),
        ("Mexico",     34.0,  0),
    ],
    2006: [
        ("Brazil",      3.25, 0),
        ("England",     7.5,  0),
        ("Germany",     8.0,  0),
        ("Italy",      10.0,  1),
        ("Argentina",   8.5,  0),
        ("France",     13.0,  0),
        ("Spain",      13.0,  0),
        ("Netherlands",17.0,  0),
        ("Portugal",   29.0,  0),
        ("Czech Rep.", 51.0,  0),
        ("Mexico",     67.0,  0),
        ("USA",       101.0,  0),
    ],
    2010: [
        ("Spain",       5.5,  1),
        ("Brazil",      5.0,  0),
        ("England",     7.5,  0),
        ("Argentina",   8.0,  0),
        ("Germany",    13.0,  0),
        ("Italy",      17.0,  0),
        ("Netherlands",13.0,  0),
        ("France",     19.0,  0),
        ("Portugal",   23.0,  0),
        ("Ivory Coast",36.0,  0),
        ("Mexico",     67.0,  0),
        ("USA",        81.0,  0),
        ("Uruguay",    81.0,  0),
        ("Ghana",      81.0,  0),
    ],
    2014: [
        ("Brazil",      3.5,  0),
        ("Argentina",   5.0,  0),
        ("Germany",     6.5,  1),
        ("Spain",       7.0,  0),
        ("Belgium",    15.0,  0),
        ("Netherlands",21.0,  0),
        ("France",     21.0,  0),
        ("Italy",      26.0,  0),
        ("England",    29.0,  0),
        ("Portugal",   29.0,  0),
        ("Colombia",   34.0,  0),
        ("Uruguay",    34.0,  0),
        ("Chile",      41.0,  0),
        ("USA",       151.0,  0),
    ],
    2018: [
        ("Brazil",      5.0,  0),
        ("Germany",     5.5,  0),
        ("Spain",       7.0,  0),
        ("France",      7.5,  1),
        ("Argentina",  10.0,  0),
        ("Belgium",    12.0,  0),
        ("England",    17.0,  0),
        ("Portugal",   26.0,  0),
        ("Uruguay",    34.0,  0),
        ("Croatia",    34.0,  0),
        ("Colombia",   41.0,  0),
        ("Poland",     51.0,  0),
        ("Mexico",     81.0,  0),
        ("Russia",    101.0,  0),
    ],
    2022: [
        ("Brazil",      4.5,  0),
        ("France",      6.0,  0),
        ("England",     8.0,  0),
        ("Argentina",   8.5,  1),
        ("Spain",      10.0,  0),
        ("Germany",    11.0,  0),
        ("Netherlands",11.0,  0),
        ("Portugal",   13.0,  0),
        ("Belgium",    13.0,  0),
        ("Uruguay",    26.0,  0),
        ("Denmark",    34.0,  0),
        ("Croatia",    41.0,  0),
        ("USA",       126.0,  0),
        ("Mexico",     81.0,  0),
        ("Morocco",   201.0,  0),
    ],
}


# =============================================================================
# NBA Finals 2010-2024 (preseason title odds)
# Source: Las Vegas opening odds, ESPN / Vegas Insider archives
# =============================================================================

NBA: Dict[int, List[Tuple[str, float, int]]] = {
    2010: [
        ("Lakers",      2.75, 1),
        ("Cavaliers",   3.5,  0),
        ("Celtics",     7.0,  0),
        ("Magic",       8.0,  0),
        ("Spurs",      10.0,  0),
        ("Nuggets",    15.0,  0),
        ("Mavericks",  17.0,  0),
        ("Suns",       34.0,  0),
    ],
    2011: [
        ("Heat",        2.5,  0),
        ("Lakers",      4.0,  0),
        ("Celtics",     6.0,  0),
        ("Magic",      11.0,  0),
        ("Spurs",      15.0,  0),
        ("Bulls",      11.0,  0),
        ("Mavericks",  34.0,  1),
        ("Thunder",    11.0,  0),
    ],
    2012: [
        ("Heat",        2.6,  1),
        ("Bulls",       6.0,  0),
        ("Lakers",      9.0,  0),
        ("Thunder",     6.5,  0),
        ("Celtics",    13.0,  0),
        ("Mavericks",  17.0,  0),
        ("Spurs",      11.0,  0),
        ("Nuggets",    34.0,  0),
    ],
    2013: [
        ("Heat",        2.0,  1),
        ("Thunder",     4.5,  0),
        ("Lakers",      8.0,  0),
        ("Spurs",       9.0,  0),
        ("Bulls",      10.0,  0),
        ("Clippers",   12.0,  0),
        ("Nuggets",    21.0,  0),
        ("Knicks",     34.0,  0),
    ],
    2014: [
        ("Heat",        2.4,  0),
        ("Thunder",     5.0,  0),
        ("Bulls",       8.0,  0),
        ("Clippers",   11.0,  0),
        ("Pacers",     11.0,  0),
        ("Spurs",      15.0,  1),
        ("Nets",       17.0,  0),
        ("Rockets",    21.0,  0),
    ],
    2015: [
        ("Cavaliers",   3.0,  0),
        ("Bulls",       9.0,  0),
        ("Spurs",       8.0,  0),
        ("Thunder",     8.5,  0),
        ("Warriors",   17.0,  1),
        ("Clippers",   13.0,  0),
        ("Rockets",    19.0,  0),
        ("Heat",       21.0,  0),
    ],
    2016: [
        ("Warriors",    2.2,  0),
        ("Cavaliers",   6.0,  1),
        ("Spurs",       8.5,  0),
        ("Thunder",    11.0,  0),
        ("Clippers",   17.0,  0),
        ("Bulls",      29.0,  0),
        ("Rockets",    41.0,  0),
        ("Hawks",      34.0,  0),
    ],
    2017: [
        ("Warriors",    1.85, 1),
        ("Cavaliers",   3.5,  0),
        ("Spurs",      11.0,  0),
        ("Thunder",    21.0,  0),
        ("Celtics",    17.0,  0),
        ("Clippers",   17.0,  0),
        ("Rockets",    21.0,  0),
        ("Raptors",    23.0,  0),
    ],
    2018: [
        ("Warriors",    1.7,  1),
        ("Rockets",     6.5,  0),
        ("Cavaliers",   8.5,  0),
        ("Celtics",    11.0,  0),
        ("Thunder",    15.0,  0),
        ("Spurs",      19.0,  0),
        ("Wolves",     34.0,  0),
        ("Raptors",    21.0,  0),
    ],
    2019: [
        ("Warriors",    1.7,  0),
        ("Celtics",     8.0,  0),
        ("Lakers",     11.0,  0),
        ("Bucks",      15.0,  0),
        ("Rockets",    15.0,  0),
        ("Sixers",     17.0,  0),
        ("Raptors",    34.0,  1),
        ("Nuggets",    51.0,  0),
    ],
    2020: [
        ("Lakers",      7.0,  1),
        ("Bucks",       4.5,  0),
        ("Clippers",    4.0,  0),
        ("Sixers",     11.0,  0),
        ("Rockets",    21.0,  0),
        ("Celtics",    17.0,  0),
        ("Nuggets",    21.0,  0),
        ("Heat",       51.0,  0),
        ("Raptors",    21.0,  0),
    ],
    2021: [
        ("Lakers",      4.0,  0),
        ("Nets",        5.5,  0),
        ("Bucks",      15.0,  1),
        ("Clippers",   12.0,  0),
        ("Heat",       21.0,  0),
        ("Sixers",     19.0,  0),
        ("Nuggets",    21.0,  0),
        ("Suns",       41.0,  0),
    ],
    2022: [
        ("Nets",        6.5,  0),
        ("Lakers",     12.0,  0),
        ("Bucks",       6.0,  0),
        ("Warriors",   15.0,  1),
        ("Suns",       11.0,  0),
        ("Heat",       12.0,  0),
        ("Sixers",     11.0,  0),
        ("Nuggets",    21.0,  0),
    ],
    2023: [
        ("Bucks",       6.0,  0),
        ("Celtics",     6.5,  0),
        ("Warriors",    8.0,  0),
        ("Suns",       11.0,  0),
        ("Nuggets",    13.0,  1),
        ("Sixers",     11.0,  0),
        ("Heat",       29.0,  0),
        ("Lakers",     21.0,  0),
    ],
    2024: [
        ("Celtics",     4.0,  1),
        ("Nuggets",     5.0,  0),
        ("Bucks",       7.0,  0),
        ("Suns",        9.0,  0),
        ("Mavericks",  17.0,  0),
        ("Thunder",    11.0,  0),
        ("Wolves",     15.0,  0),
        ("Knicks",     21.0,  0),
    ],
}


# =============================================================================
# NHL Stanley Cup 2010-2024 (preseason title odds)
# =============================================================================

NHL: Dict[int, List[Tuple[str, float, int]]] = {
    2010: [
        ("Penguins",    8.0,  0),
        ("Red Wings",   8.0,  0),
        ("Capitals",    9.0,  0),
        ("Blackhawks", 12.0,  1),
        ("Sharks",     10.0,  0),
        ("Bruins",     17.0,  0),
        ("Devils",     19.0,  0),
        ("Flyers",     21.0,  0),
    ],
    2011: [
        ("Capitals",    7.0,  0),
        ("Penguins",    9.0,  0),
        ("Sharks",      9.0,  0),
        ("Blackhawks", 11.0,  0),
        ("Red Wings",  11.0,  0),
        ("Canucks",    11.0,  0),
        ("Bruins",     17.0,  1),
        ("Flyers",     17.0,  0),
    ],
    2012: [
        ("Penguins",    8.0,  0),
        ("Rangers",     9.0,  0),
        ("Bruins",      9.0,  0),
        ("Canucks",    11.0,  0),
        ("Red Wings",  11.0,  0),
        ("Kings",      17.0,  1),
        ("Capitals",   17.0,  0),
        ("Predators",  21.0,  0),
    ],
    2013: [
        ("Penguins",    7.5,  0),
        ("Blackhawks",  9.0,  1),
        ("Rangers",    11.0,  0),
        ("Kings",      13.0,  0),
        ("Bruins",     11.0,  0),
        ("Canucks",    15.0,  0),
        ("Capitals",   19.0,  0),
        ("Red Wings",  21.0,  0),
    ],
    2014: [
        ("Blackhawks",  7.0,  0),
        ("Penguins",    8.0,  0),
        ("Bruins",      9.0,  0),
        ("Rangers",    11.0,  0),
        ("Kings",      11.0,  1),
        ("Sharks",     11.0,  0),
        ("Capitals",   17.0,  0),
        ("Red Wings",  21.0,  0),
    ],
    2015: [
        ("Blackhawks",  8.0,  1),
        ("Bruins",      9.0,  0),
        ("Penguins",   10.0,  0),
        ("Kings",      11.0,  0),
        ("Lightning",  13.0,  0),
        ("Rangers",    12.0,  0),
        ("Ducks",      15.0,  0),
        ("Capitals",   17.0,  0),
    ],
    2016: [
        ("Blackhawks",  7.0,  0),
        ("Capitals",    9.0,  0),
        ("Penguins",   11.0,  1),
        ("Lightning",  13.0,  0),
        ("Stars",      15.0,  0),
        ("Rangers",    15.0,  0),
        ("Kings",      17.0,  0),
        ("Bruins",     17.0,  0),
    ],
    2017: [
        ("Penguins",    8.0,  1),
        ("Capitals",    9.0,  0),
        ("Blackhawks", 10.0,  0),
        ("Lightning",  13.0,  0),
        ("Predators",  21.0,  0),
        ("Rangers",    17.0,  0),
        ("Wild",       21.0,  0),
        ("Senators",   34.0,  0),
    ],
    2018: [
        ("Penguins",    8.0,  0),
        ("Predators",   8.0,  0),
        ("Capitals",   13.0,  1),
        ("Lightning",  11.0,  0),
        ("Blackhawks", 13.0,  0),
        ("Bruins",     17.0,  0),
        ("Maple Leafs",17.0,  0),
        ("Jets",       21.0,  0),
    ],
    2019: [
        ("Predators",  10.0,  0),
        ("Lightning",   8.0,  0),
        ("Bruins",     11.0,  0),
        ("Maple Leafs",13.0,  0),
        ("Capitals",   13.0,  0),
        ("Jets",       15.0,  0),
        ("Blues",      31.0,  1),
        ("Sharks",     17.0,  0),
    ],
    2020: [
        ("Lightning",  10.0,  1),
        ("Bruins",      9.0,  0),
        ("Avalanche",  11.0,  0),
        ("Maple Leafs",13.0,  0),
        ("Capitals",   15.0,  0),
        ("Stars",      29.0,  0),
        ("Blues",      15.0,  0),
        ("Golden Knights", 11.0, 0),
    ],
    2021: [
        ("Lightning",   9.0,  1),
        ("Avalanche",   9.0,  0),
        ("Golden Knights", 9.0, 0),
        ("Bruins",     13.0,  0),
        ("Maple Leafs",15.0,  0),
        ("Penguins",   17.0,  0),
        ("Capitals",   17.0,  0),
        ("Stars",      21.0,  0),
    ],
    2022: [
        ("Avalanche",   8.0,  1),
        ("Lightning",   9.0,  0),
        ("Maple Leafs",13.0,  0),
        ("Hurricanes", 11.0,  0),
        ("Golden Knights", 13.0, 0),
        ("Panthers",   13.0,  0),
        ("Oilers",     17.0,  0),
        ("Rangers",    17.0,  0),
    ],
    2023: [
        ("Avalanche",   8.0,  0),
        ("Oilers",     10.0,  0),
        ("Maple Leafs",11.0,  0),
        ("Hurricanes", 13.0,  0),
        ("Lightning",  13.0,  0),
        ("Golden Knights",17.0, 1),
        ("Stars",      17.0,  0),
        ("Panthers",   34.0,  0),
    ],
    2024: [
        ("Avalanche",   9.0,  0),
        ("Oilers",      9.0,  0),
        ("Hurricanes", 11.0,  0),
        ("Stars",      11.0,  0),
        ("Maple Leafs",13.0,  0),
        ("Panthers",   13.0,  1),
        ("Rangers",    17.0,  0),
        ("Bruins",     15.0,  0),
        ("Golden Knights",13.0, 0),
    ],
}


# =============================================================================
# Super Bowl 2010-2024 (preseason title odds, season year ends in season label)
# Year here = year the Super Bowl was played (Feb).
# =============================================================================

NFL: Dict[int, List[Tuple[str, float, int]]] = {
    2010: [
        ("Patriots",    7.0,  0),
        ("Steelers",    9.0,  0),
        ("Saints",     15.0,  1),
        ("Vikings",    13.0,  0),
        ("Cowboys",    17.0,  0),
        ("Colts",       9.0,  0),
        ("Eagles",     21.0,  0),
        ("Chargers",   11.0,  0),
    ],
    2011: [
        ("Patriots",    7.0,  0),
        ("Colts",       9.0,  0),
        ("Saints",     11.0,  0),
        ("Steelers",    9.0,  0),
        ("Packers",    11.0,  1),
        ("Chargers",   12.0,  0),
        ("Vikings",    17.0,  0),
        ("Cowboys",    15.0,  0),
    ],
    2012: [
        ("Packers",     6.0,  0),
        ("Patriots",    7.0,  0),
        ("Steelers",    9.0,  0),
        ("Saints",     11.0,  0),
        ("Giants",     21.0,  1),
        ("Eagles",     11.0,  0),
        ("Ravens",     12.0,  0),
        ("Jets",       15.0,  0),
    ],
    2013: [
        ("Patriots",    7.0,  0),
        ("49ers",       7.5,  0),
        ("Packers",     8.0,  0),
        ("Broncos",     8.5,  0),
        ("Ravens",     21.0,  1),
        ("Texans",     11.0,  0),
        ("Falcons",    15.0,  0),
        ("Steelers",   15.0,  0),
    ],
    2014: [
        ("Broncos",     7.0,  0),
        ("Seahawks",    9.0,  1),
        ("49ers",       7.5,  0),
        ("Patriots",    9.0,  0),
        ("Packers",     9.0,  0),
        ("Saints",     13.0,  0),
        ("Bengals",    21.0,  0),
        ("Eagles",     21.0,  0),
    ],
    2015: [
        ("Seahawks",    6.0,  0),
        ("Patriots",    7.5,  1),
        ("Packers",     8.0,  0),
        ("Broncos",     9.0,  0),
        ("Cowboys",    19.0,  0),
        ("Colts",       9.0,  0),
        ("Ravens",     17.0,  0),
        ("Eagles",     17.0,  0),
    ],
    2016: [
        ("Patriots",    7.0,  0),
        ("Packers",     9.0,  0),
        ("Seahawks",   10.0,  0),
        ("Steelers",   13.0,  0),
        ("Broncos",    11.0,  1),
        ("Cardinals",  11.0,  0),
        ("Bengals",    15.0,  0),
        ("Panthers",   17.0,  0),
    ],
    2017: [
        ("Patriots",    5.5,  1),
        ("Seahawks",    9.0,  0),
        ("Packers",    11.0,  0),
        ("Steelers",   11.0,  0),
        ("Falcons",    21.0,  0),
        ("Cowboys",    21.0,  0),
        ("Raiders",    13.0,  0),
        ("Broncos",    15.0,  0),
    ],
    2018: [
        ("Patriots",    5.0,  0),
        ("Eagles",     11.0,  1),
        ("Packers",    11.0,  0),
        ("Steelers",   11.0,  0),
        ("Falcons",    13.0,  0),
        ("Vikings",    15.0,  0),
        ("Seahawks",   15.0,  0),
        ("Saints",     21.0,  0),
    ],
    2019: [
        ("Patriots",    7.5,  1),
        ("Rams",        8.5,  0),
        ("Chiefs",      9.0,  0),
        ("Saints",     11.0,  0),
        ("Eagles",     13.0,  0),
        ("Bears",      17.0,  0),
        ("Chargers",   17.0,  0),
        ("Cowboys",    21.0,  0),
    ],
    2020: [
        ("Chiefs",      6.5,  1),
        ("Ravens",      8.0,  0),
        ("Patriots",   10.0,  0),
        ("49ers",       8.0,  0),
        ("Saints",     11.0,  0),
        ("Packers",    15.0,  0),
        ("Seahawks",   15.0,  0),
        ("Cowboys",    19.0,  0),
    ],
    2021: [
        ("Chiefs",      6.0,  0),
        ("Bucs",       12.0,  1),
        ("Ravens",     10.0,  0),
        ("Saints",     12.0,  0),
        ("49ers",      13.0,  0),
        ("Packers",    15.0,  0),
        ("Bills",      15.0,  0),
        ("Seahawks",   17.0,  0),
    ],
    2022: [
        ("Chiefs",      8.5,  0),
        ("Bills",       7.0,  0),
        ("Bucs",        9.0,  0),
        ("Packers",    10.0,  0),
        ("Rams",       11.0,  1),
        ("Cowboys",    21.0,  0),
        ("Ravens",     15.0,  0),
        ("49ers",      15.0,  0),
    ],
    2023: [
        ("Bills",       7.0,  0),
        ("Chiefs",      8.5,  1),
        ("Eagles",      9.0,  0),
        ("49ers",      11.0,  0),
        ("Bucs",       17.0,  0),
        ("Bengals",    11.0,  0),
        ("Cowboys",    17.0,  0),
        ("Ravens",     11.0,  0),
    ],
    2024: [
        ("Chiefs",      6.5,  1),
        ("49ers",       7.0,  0),
        ("Bills",       9.0,  0),
        ("Eagles",     11.0,  0),
        ("Cowboys",    13.0,  0),
        ("Bengals",    13.0,  0),
        ("Lions",      21.0,  0),
        ("Ravens",     17.0,  0),
    ],
}


# =============================================================================
# Wimbledon 2015-2024 (men's + women's pre-tournament odds)
# 2020 cancelled (COVID); skipped.
# =============================================================================

WIMBLEDON_MENS: Dict[int, List[Tuple[str, float, int]]] = {
    2015: [
        ("Djokovic",    1.7,  1),
        ("Federer",     5.0,  0),
        ("Murray",      6.0,  0),
        ("Wawrinka",   17.0,  0),
        ("Nadal",      21.0,  0),
        ("Berdych",    34.0,  0),
        ("Raonic",     51.0,  0),
        ("Cilic",      51.0,  0),
    ],
    2016: [
        ("Djokovic",    1.5,  0),
        ("Murray",      4.5,  1),
        ("Federer",     8.0,  0),
        ("Nadal",      17.0,  0),
        ("Wawrinka",   17.0,  0),
        ("Raonic",     21.0,  0),
        ("Cilic",      34.0,  0),
        ("Thiem",      34.0,  0),
    ],
    2017: [
        ("Murray",      4.0,  0),
        ("Djokovic",    5.0,  0),
        ("Federer",     5.5,  1),
        ("Nadal",       9.0,  0),
        ("Wawrinka",   13.0,  0),
        ("Cilic",      17.0,  0),
        ("Zverev",     21.0,  0),
        ("Thiem",      21.0,  0),
    ],
    2018: [
        ("Federer",     2.5,  0),
        ("Nadal",       5.5,  0),
        ("Djokovic",    7.5,  1),
        ("Cilic",       9.0,  0),
        ("Zverev",     13.0,  0),
        ("Del Potro",  13.0,  0),
        ("Anderson",   34.0,  0),
        ("Thiem",      26.0,  0),
    ],
    2019: [
        ("Djokovic",    2.5,  1),
        ("Federer",     3.5,  0),
        ("Nadal",       5.0,  0),
        ("Tsitsipas",  21.0,  0),
        ("Zverev",     21.0,  0),
        ("Thiem",      26.0,  0),
        ("Medvedev",   51.0,  0),
        ("Nishikori",  51.0,  0),
    ],
    2021: [
        ("Djokovic",    1.9,  1),
        ("Federer",     8.0,  0),
        ("Nadal",      11.0,  0),
        ("Medvedev",   13.0,  0),
        ("Tsitsipas",  13.0,  0),
        ("Zverev",     21.0,  0),
        ("Berrettini", 34.0,  0),
        ("Shapovalov", 51.0,  0),
    ],
    2022: [
        ("Djokovic",    2.0,  1),
        ("Nadal",       4.0,  0),
        ("Alcaraz",     9.0,  0),
        ("Medvedev",   13.0,  0),
        ("Tsitsipas",  17.0,  0),
        ("Berrettini", 21.0,  0),
        ("Zverev",     26.0,  0),
        ("Sinner",     21.0,  0),
    ],
    2023: [
        ("Djokovic",    1.8,  0),
        ("Alcaraz",     3.5,  1),
        ("Medvedev",   11.0,  0),
        ("Sinner",     15.0,  0),
        ("Rune",       21.0,  0),
        ("Tsitsipas",  26.0,  0),
        ("Fritz",      51.0,  0),
        ("Rublev",     51.0,  0),
    ],
    2024: [
        ("Djokovic",    3.5,  0),
        ("Alcaraz",     2.6,  1),
        ("Sinner",      5.0,  0),
        ("Medvedev",   13.0,  0),
        ("Rune",       21.0,  0),
        ("Hurkacz",    34.0,  0),
        ("Zverev",     34.0,  0),
        ("Tsitsipas",  51.0,  0),
    ],
}

WIMBLEDON_WOMENS: Dict[int, List[Tuple[str, float, int]]] = {
    2015: [
        ("Serena Williams", 2.0, 1),
        ("Sharapova",       8.0, 0),
        ("Halep",          13.0, 0),
        ("Kvitova",        11.0, 0),
        ("Wozniacki",      26.0, 0),
        ("Radwanska",      26.0, 0),
        ("Bouchard",       34.0, 0),
        ("Azarenka",       34.0, 0),
    ],
    2016: [
        ("Serena Williams", 2.5, 1),
        ("Kerber",          6.0, 0),
        ("Halep",          13.0, 0),
        ("Muguruza",       11.0, 0),
        ("Radwanska",      17.0, 0),
        ("Kvitova",        17.0, 0),
        ("Williams (V.)",  34.0, 0),
        ("Pliskova",       34.0, 0),
    ],
    2017: [
        ("Kerber",          5.0, 0),
        ("Pliskova",        7.0, 0),
        ("Halep",           7.0, 0),
        ("Konta",          11.0, 0),
        ("Muguruza",       11.0, 1),
        ("Williams (V.)",  17.0, 0),
        ("Wozniacki",      17.0, 0),
        ("Svitolina",      17.0, 0),
    ],
    2018: [
        ("Halep",           5.0, 0),
        ("Wozniacki",       9.0, 0),
        ("Kvitova",        11.0, 0),
        ("Pliskova",       11.0, 0),
        ("Stephens",       17.0, 0),
        ("Muguruza",       11.0, 0),
        ("Kerber",         17.0, 1),
        ("Sharapova",      26.0, 0),
    ],
    2019: [
        ("Barty",           7.0, 0),
        ("Halep",           9.0, 1),
        ("Serena Williams", 6.0, 0),
        ("Pliskova",       11.0, 0),
        ("Osaka",           9.0, 0),
        ("Kvitova",        13.0, 0),
        ("Kerber",         17.0, 0),
        ("Andreescu",      34.0, 0),
    ],
    2021: [
        ("Barty",           5.0, 1),
        ("Osaka",           7.0, 0),
        ("Serena Williams", 8.0, 0),
        ("Kenin",          13.0, 0),
        ("Sabalenka",      11.0, 0),
        ("Swiatek",        15.0, 0),
        ("Pliskova",       21.0, 0),
        ("Halep",          13.0, 0),
    ],
    2022: [
        ("Swiatek",         3.5, 0),
        ("Sabalenka",       9.0, 0),
        ("Pliskova",       11.0, 0),
        ("Halep",          13.0, 0),
        ("Rybakina",       51.0, 1),
        ("Jabeur",         13.0, 0),
        ("Kontaveit",      17.0, 0),
        ("Krejcikova",     17.0, 0),
    ],
    2023: [
        ("Swiatek",         3.5, 0),
        ("Sabalenka",       6.0, 0),
        ("Rybakina",        7.0, 0),
        ("Gauff",          15.0, 0),
        ("Pegula",         21.0, 0),
        ("Jabeur",         11.0, 0),
        ("Vondrousova",    81.0, 1),
        ("Svitolina",      34.0, 0),
    ],
    2024: [
        ("Swiatek",         3.5, 0),
        ("Sabalenka",       5.0, 0),
        ("Rybakina",        7.0, 0),
        ("Gauff",          11.0, 0),
        ("Pegula",         21.0, 0),
        ("Krejcikova",     34.0, 1),
        ("Jabeur",         15.0, 0),
        ("Paolini",        51.0, 0),
    ],
}


# =============================================================================
# UEFA Euro 2008-2024
# Source: pre-tournament opening odds (Ladbrokes / William Hill archives).
# Winners marked outcome=1.
# =============================================================================

EUROS: Dict[int, List[Tuple[str, float, int]]] = {
    2008: [
        ("Germany",     6.0,  0),
        ("Italy",       7.0,  0),
        ("France",      7.5,  0),
        ("Spain",       7.5,  1),
        ("Portugal",    9.0,  0),
        ("Netherlands", 11.0, 0),
        ("Croatia",    21.0,  0),
        ("Czech Rep.", 26.0,  0),
        ("Greece",     34.0,  0),
        ("Sweden",     41.0,  0),
        ("Russia",     51.0,  0),
        ("Turkey",     67.0,  0),
    ],
    2012: [
        ("Spain",       4.5,  1),
        ("Germany",     4.0,  0),
        ("Netherlands", 8.0,  0),
        ("England",    13.0,  0),
        ("Italy",      15.0,  0),
        ("France",     11.0,  0),
        ("Portugal",   17.0,  0),
        ("Russia",     21.0,  0),
        ("Croatia",    34.0,  0),
        ("Sweden",     51.0,  0),
        ("Greece",    101.0,  0),
        ("Ukraine",    81.0,  0),
    ],
    2016: [
        ("Germany",     5.0,  0),
        ("France",      4.5,  0),
        ("Spain",       6.5,  0),
        ("England",    11.0,  0),
        ("Belgium",    11.0,  0),
        ("Italy",      15.0,  0),
        ("Portugal",   23.0,  1),
        ("Croatia",    23.0,  0),
        ("Poland",     34.0,  0),
        ("Russia",     34.0,  0),
        ("Switzerland",51.0,  0),
        ("Wales",     101.0,  0),
    ],
    2020: [
        ("France",      5.5,  0),
        ("England",     6.0,  0),
        ("Belgium",     7.0,  0),
        ("Germany",     8.0,  0),
        ("Spain",       9.0,  0),
        ("Portugal",    9.0,  0),
        ("Netherlands",11.0,  0),
        ("Italy",      11.0,  1),
        ("Croatia",    26.0,  0),
        ("Denmark",    51.0,  0),
        ("Switzerland",51.0,  0),
        ("Poland",     67.0,  0),
    ],
    2024: [
        ("France",      4.5,  0),
        ("England",     4.5,  0),
        ("Germany",     7.5,  0),
        ("Spain",       8.0,  1),
        ("Portugal",   10.0,  0),
        ("Netherlands",13.0,  0),
        ("Italy",      13.0,  0),
        ("Belgium",    13.0,  0),
        ("Croatia",    21.0,  0),
        ("Denmark",    34.0,  0),
        ("Switzerland",41.0,  0),
        ("Austria",    51.0,  0),
    ],
}


# =============================================================================
# Copa America 2015-2024
# Source: pre-tournament opening odds. South American odds tightly clustered
# around Argentina + Brazil; vig removal then renormalization keeps the field
# realistic. Winners marked outcome=1.
# =============================================================================

COPA: Dict[int, List[Tuple[str, float, int]]] = {
    2015: [
        ("Argentina",   2.5,  0),
        ("Brazil",      4.0,  0),
        ("Chile",       6.0,  1),
        ("Colombia",    9.0,  0),
        ("Uruguay",    11.0,  0),
        ("Mexico",     26.0,  0),
        ("Peru",       34.0,  0),
        ("Ecuador",    51.0,  0),
        ("Paraguay",   34.0,  0),
        ("Bolivia",   151.0,  0),
        ("Venezuela",  81.0,  0),
        ("Jamaica",   251.0,  0),
    ],
    2016: [
        ("Argentina",   2.6,  0),
        ("Brazil",      4.5,  0),
        ("Chile",       7.0,  1),
        ("Colombia",   11.0,  0),
        ("Uruguay",    11.0,  0),
        ("Mexico",     17.0,  0),
        ("USA",        21.0,  0),
        ("Peru",       41.0,  0),
        ("Ecuador",    51.0,  0),
        ("Paraguay",   51.0,  0),
        ("Costa Rica",126.0,  0),
        ("Bolivia",   251.0,  0),
    ],
    2019: [
        ("Brazil",      2.6,  1),
        ("Argentina",   4.0,  0),
        ("Uruguay",     6.0,  0),
        ("Colombia",   10.0,  0),
        ("Chile",      11.0,  0),
        ("Peru",       17.0,  0),
        ("Paraguay",   34.0,  0),
        ("Ecuador",    51.0,  0),
        ("Venezuela",  51.0,  0),
        ("Japan",      81.0,  0),
        ("Qatar",     101.0,  0),
        ("Bolivia",   151.0,  0),
    ],
    2021: [
        ("Brazil",      2.6,  0),
        ("Argentina",   4.0,  1),
        ("Uruguay",     7.0,  0),
        ("Colombia",   11.0,  0),
        ("Chile",      11.0,  0),
        ("Peru",       17.0,  0),
        ("Paraguay",   29.0,  0),
        ("Ecuador",    34.0,  0),
        ("Venezuela",  81.0,  0),
        ("Bolivia",   151.0,  0),
    ],
    2024: [
        ("Argentina",   2.5,  1),
        ("Brazil",      4.5,  0),
        ("Uruguay",     7.5,  0),
        ("Colombia",    9.0,  0),
        ("USA",        13.0,  0),
        ("Mexico",     17.0,  0),
        ("Chile",      26.0,  0),
        ("Ecuador",    34.0,  0),
        ("Venezuela",  29.0,  0),
        ("Peru",       51.0,  0),
        ("Paraguay",   81.0,  0),
        ("Canada",     67.0,  0),
        ("Panama",    101.0,  0),
        ("Costa Rica",151.0,  0),
        ("Jamaica",   151.0,  0),
        ("Bolivia",   251.0,  0),
    ],
}


def renormalize(rows: List[Tuple[str, float, int]]) -> List[Tuple[str, float, float, float, int]]:
    """For one tournament, compute raw implied prob + vig-removed implied prob."""
    raw = [(name, odds, 1.0 / odds, outcome) for (name, odds, outcome) in rows]
    sum_raw = sum(r[2] for r in raw)
    if sum_raw <= 0:
        return [(name, odds, ip, ip, outcome) for (name, odds, ip, outcome) in raw]
    return [(name, odds, ip, ip / sum_raw, outcome) for (name, odds, ip, outcome) in raw]


def write_csv() -> None:
    rows = []
    bundles = [
        ("fifa",            "world_cup",      FIFA),
        ("fifa",            "euros",          EUROS),
        ("fifa",            "copa_america",   COPA),
        ("nba",             "nba_finals",     NBA),
        ("nhl",             "stanley_cup",    NHL),
        ("nfl",             "super_bowl",     NFL),
        ("tennis",          "wimbledon_mens", WIMBLEDON_MENS),
        ("tennis",          "wimbledon_womens", WIMBLEDON_WOMENS),
    ]
    for sport, tournament, data in bundles:
        for year, members in data.items():
            renorm = renormalize(members)
            for name, odds, raw, vig_removed, outcome in renorm:
                rows.append({
                    "sport": sport,
                    "tournament": tournament,
                    "year": year,
                    "team_player": name,
                    "decimal_odds": round(odds, 3),
                    "implied_prob_raw": round(raw, 5),
                    "implied_prob": round(vig_removed, 5),
                    "outcome": outcome,
                })
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "sport", "tournament", "year", "team_player",
            "decimal_odds", "implied_prob_raw", "implied_prob", "outcome",
        ])
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"Wrote {len(rows)} rows to {OUT}")
    by_sport: Dict[str, int] = {}
    by_winners: Dict[str, int] = {}
    for r in rows:
        by_sport[r["sport"]] = by_sport.get(r["sport"], 0) + 1
        if r["outcome"] == 1:
            by_winners[r["sport"]] = by_winners.get(r["sport"], 0) + 1
    print("by sport:")
    for k in sorted(by_sport):
        print(f"  {k}: {by_sport[k]} rows, {by_winners.get(k, 0)} winners")


if __name__ == "__main__":
    write_csv()
